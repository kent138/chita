<?php
declare(strict_types=1);

/*
 * Matreshka buyers' independent Russian-hosted authentication API.
 *
 * Place this file as public_html/api.php on the Russian PHP hosting.
 * A private config (matreshka-auth-config.php) MUST be outside public_html.
 * Browser -> HTTPS Russian host directly. Never proxy passwords through Vercel.
 */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Frame-Options: DENY');

function reply(int $code, array $data): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    exit;
}
function failure(string $message, int $status = 400): void {
    reply($status, ['error' => $message]);
}
function method(string $expected): void {
    if ($_SERVER['REQUEST_METHOD'] !== $expected) {
        header('Allow: ' . $expected);
        failure('Неподдерживаемый метод запроса', 405);
    }
}
function config(): array {
    $file = dirname(__DIR__) . '/matreshka-auth-config.php';
    if (!is_readable($file)) {
        failure('Сервер аккаунтов ещё не настроен', 503);
    }
    $cfg = require $file;
    if (!is_array($cfg)) {
        failure('Неверная конфигурация аккаунтов', 503);
    }
    $secret = $cfg['secret'] ?? '';
    if (!is_string($secret) || !preg_match('/^[a-f0-9]{64}$/i', $secret)) {
        failure('Ключ безопасности аккаунтов не настроен', 503);
    }
    return $cfg;
}
function database(array $cfg): PDO {
    foreach (['db_host','db_name','db_user','db_password'] as $name) {
        if (!isset($cfg[$name]) || !is_string($cfg[$name]) || $cfg[$name] === '') {
            failure('База аккаунтов не настроена', 503);
        }
    }
    try {
        $pdo = new PDO(
            'mysql:host=' . $cfg['db_host'] .
            ';port=' . (int)($cfg['db_port'] ?? 3306) .
            ';dbname=' . $cfg['db_name'] . ';charset=utf8mb4',
            $cfg['db_user'],
            $cfg['db_password'],
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
                PDO::ATTR_TIMEOUT => 8,
            ]
        );
        $pdo->exec("SET time_zone = '+00:00'");
        return $pdo;
    } catch (PDOException $e) {
        error_log('[MTR ACCOUNTS DB] connection failed');
        failure('База аккаунтов временно недоступна', 503);
    }
}
function input(): array {
    if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 16384) {
        failure('Слишком большой запрос', 413);
    }
    $body = file_get_contents('php://input', false, null, 0, 16385);
    if (strlen((string)$body) > 16384) {
        failure('Слишком большой запрос', 413);
    }
    try {
        $data = json_decode((string)$body, true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($data) || array_is_list($data)) {
            failure('Ожидается JSON-объект');
        }
        return $data;
    } catch (JsonException $e) {
        failure('Некорректный JSON');
    }
}
function username($value): string {
    if (!is_string($value)) {
        failure('Укажите логин');
    }
    $name = strtolower(trim($value));
    if (!preg_match('/^[a-z0-9_.-]{3,32}$/', $name)) {
        failure('Логин: от 3 до 32 латинских букв, цифр, точек, дефисов или подчёркиваний');
    }
    return $name;
}
function password($value): string {
    if (!is_string($value) || strlen($value) < 10 || strlen($value) > 128) {
        failure('Пароль должен содержать от 10 до 128 символов');
    }
    return $value;
}
function identity(array $cfg, string $purpose): string {
    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
    return hash_hmac('sha256', $purpose . '|' . substr($ip,0,128), $cfg['secret']);
}
function rateCheck(PDO $db, string $key): void {
    $stmt=$db->prepare('SELECT blocked_until FROM mtr_rate_limits WHERE key_hash=?');
    $stmt->execute([$key]);
    $record=$stmt->fetch();
    if ($record && !empty($record['blocked_until']) &&
        strtotime($record['blocked_until'] . ' UTC') > time()) {
        failure('Слишком много попыток. Попробуйте через 15 минут.',429);
    }
}
function rateFailure(PDO $db, string $key): void {
    $stmt=$db->prepare(
        'INSERT INTO mtr_rate_limits(key_hash,failures,blocked_until,updated_at) ' .
        'VALUES(?,1,NULL,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE ' .
        'failures=IF(updated_at<UTC_TIMESTAMP()-INTERVAL 15 MINUTE,1,failures+1), ' .
        'blocked_until=IF(failures>=5,UTC_TIMESTAMP()+INTERVAL 15 MINUTE,NULL), ' .
        'updated_at=UTC_TIMESTAMP()'
    );
    $stmt->execute([$key]);
}
function rateSuccess(PDO $db, string $key): void {
    $stmt=$db->prepare('DELETE FROM mtr_rate_limits WHERE key_hash=?');
    $stmt->execute([$key]);
}
function newUuid(): string {
    $b=random_bytes(16);
    $b[6]=chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8]=chr((ord($b[8]) & 0x3f) | 0x80);
    $hex=bin2hex($b);
    return substr($hex,0,8).'-'.substr($hex,8,4).'-'.substr($hex,12,4).'-'.
           substr($hex,16,4).'-'.substr($hex,20,12);
}
function issueSession(PDO $db, string $accountId): string {
    $token=bin2hex(random_bytes(32));
    $stmt=$db->prepare(
        'INSERT INTO mtr_sessions(token_hash,account_id,expires_at) ' .
        'VALUES(?,?,UTC_TIMESTAMP()+INTERVAL 14 DAY)'
    );
    $stmt->execute([hash('sha256',$token),$accountId]);
    return $token;
}
function bearerToken(): string {
    $header=(string)($_SERVER['HTTP_AUTHORIZATION'] ?? '');
    if (!$header && function_exists('getallheaders')) {
        foreach (getallheaders() as $name=>$value) {
            if (strcasecmp((string)$name,'authorization')===0) {
                $header=(string)$value;
                break;
            }
        }
    }
    if (!preg_match('/^Bearer ([a-f0-9]{64})$/i', $header, $m)) {
        failure('Войдите в аккаунт',401);
    }
    return strtolower($m[1]);
}
function account(PDO $db): array {
    $token=bearerToken();
    $stmt=$db->prepare(
        'SELECT a.id,a.username,a.favorites,a.cart,a.created_at ' .
        'FROM mtr_accounts a JOIN mtr_sessions s ON s.account_id=a.id ' .
        'WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() LIMIT 1'
    );
    $stmt->execute([hash('sha256',$token)]);
    $row=$stmt->fetch();
    if (!$row)failure('Сессия истекла. Войдите заново.',401);
    return $row;
}
function displayUser(array $row): array {
    return [
        'id' => $row['id'],
        'username' => $row['username'],
        'name' => $row['username'],
        'favorites' => json_decode($row['favorites'] ?? '[]',true) ?: [],
        'cart' => json_decode($row['cart'] ?? '[]',true) ?: [],
        'createdAt' => $row['created_at'],
        'cloud' => true,
    ];
}
function validFavorites($raw): array {
    if (!is_array($raw)||!array_is_list($raw)||count($raw)>1000) {
        failure('Некорректный список избранного');
    }
    $unique=[];
    foreach ($raw as $id) {
        if (!is_int($id) || $id<=0 || $id>2147483647) {
            failure('Некорректный номер товара в избранном');
        }
        $unique[$id]=$id;
    }
    return array_values($unique);
}
function validCart($raw): array {
    if (!is_array($raw)||!array_is_list($raw)||count($raw)>150) {
        failure('Некорректная корзина');
    }
    $cart=[];
    foreach ($raw as $item) {
        if (!is_array($item) || !isset($item['id'],$item['quantity']) ||
            !is_int($item['id']) || !is_int($item['quantity']) ||
            $item['id']<=0 || $item['id']>2147483647 ||
            $item['quantity']<=0 || $item['quantity']>100) {
            failure('Некорректное количество товара');
        }
        $cart[$item['id']]=['id'=>$item['id'],'quantity'=>$item['quantity']];
    }
    return array_values($cart);
}

try {
    $cfg=config();
    $allowed=$cfg['allowed_origin'] ?? 'https://matreshka-v2.vercel.app';
    if (!is_string($allowed) || !str_starts_with($allowed,'https://')) {
        failure('Не настроен доверенный адрес магазина',503);
    }
    $origin=$_SERVER['HTTP_ORIGIN'] ?? null;
    if ($origin !== null) {
        if (!hash_equals($allowed,(string)$origin)) {
            failure('Запросы с другого сайта запрещены',403);
        }
        header('Access-Control-Allow-Origin: ' . $allowed);
        header('Vary: Origin');
        header('Access-Control-Allow-Headers: Content-Type, Authorization');
        header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
        header('Access-Control-Max-Age: 600');
    }
    if ($_SERVER['REQUEST_METHOD']==='OPTIONS') {
        http_response_code(204);
        exit;
    }
    $action=(string)($_GET['action'] ?? '');
    $db=database($cfg);
    if ($action==='health') {
        method('GET');
        $db->query('SELECT 1');
        reply(200,['ok'=>true]);
    }
    if ($action==='register') {
        method('POST');
        $data=input();
        $name=username($data['username'] ?? null);
        $pass=password($data['password'] ?? null);
        if (($data['consent'] ?? null)!==true) {
            failure('Необходимо согласие на обработку данных аккаунта');
        }
        if (($data['passwordRepeat'] ?? null)!==$pass) {
            failure('Пароли не совпадают');
        }
        $rate=identity($cfg,'register');
        rateCheck($db,$rate);
        $stmt=$db->prepare('SELECT 1 FROM mtr_accounts WHERE username=? LIMIT 1');
        $stmt->execute([$name]);
        if ($stmt->fetch()) {
            rateFailure($db,$rate);
            failure('Такой логин уже занят',409);
        }
        $id=newUuid();
        $hash=password_hash($pass,PASSWORD_BCRYPT,['cost'=>12]);
        if ($hash===false)failure('Ошибка создания профиля',500);
        try {
            $stmt=$db->prepare(
                'INSERT INTO mtr_accounts(id,username,password_hash,favorites,cart) ' .
                "VALUES(?,?,?,'[]','[]')"
            );
            $stmt->execute([$id,$name,$hash]);
        } catch (PDOException $e) {
            if ((string)$e->getCode()==='23000') {
                rateFailure($db,$rate);
                failure('Такой логин уже занят',409);
            }
            throw $e;
        }
        rateSuccess($db,$rate);
        $token=issueSession($db,$id);
        reply(201,['user'=>['id'=>$id,'username'=>$name,'name'=>$name,
            'favorites'=>[],'cart'=>[],'cloud'=>true],'token'=>$token]);
    }
    if ($action==='login') {
        method('POST');
        $data=input();
        $name=username($data['username'] ?? null);
        $pass=(string)($data['password'] ?? '');
        $rate=identity($cfg,'login:'.$name);
        rateCheck($db,$rate);
        $stmt=$db->prepare('SELECT * FROM mtr_accounts WHERE username=? LIMIT 1');
        $stmt->execute([$name]);
        $row=$stmt->fetch();
        if (!$row || !password_verify($pass,(string)$row['password_hash'])) {
            rateFailure($db,$rate);
            failure('Неверный логин или пароль',401);
        }
        rateSuccess($db,$rate);
        $token=issueSession($db,$row['id']);
        reply(200,['user'=>displayUser($row),'token'=>$token]);
    }
    if ($action==='logout') {
        method('POST');
        $token=bearerToken();
        $stmt=$db->prepare('DELETE FROM mtr_sessions WHERE token_hash=?');
        $stmt->execute([hash('sha256',$token)]);
        reply(200,['ok'=>true]);
    }
    if ($action==='me') {
        if ($_SERVER['REQUEST_METHOD']==='DELETE') {
            $row=account($db);
            $stmt=$db->prepare('DELETE FROM mtr_accounts WHERE id=?');
            $stmt->execute([$row['id']]);
            reply(200,['ok'=>true]);
        }
        method('GET');
        reply(200,displayUser(account($db)));
    }
    if ($action==='favorites' || $action==='cart') {
        method('PUT');
        $row=account($db);
        $data=input();
        $items=$action==='favorites'
            ?validFavorites($data['favorites'] ?? null)
            :validCart($data['cart'] ?? null);
        $column=$action==='favorites'?'favorites':'cart';
        $stmt=$db->prepare("UPDATE mtr_accounts SET $column=? WHERE id=?");
        $stmt->execute([
            json_encode($items,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE),
            $row['id']
        ]);
        reply(200,[$column=>$items]);
    }
    failure('Неизвестная операция',404);
} catch (PDOException $e) {
    error_log('[MTR ACCOUNTS DB] query failed');
    failure('Ошибка базы аккаунтов',503);
} catch (Throwable $e) {
    error_log('[MTR ACCOUNTS] unexpected error: '.get_class($e));
    failure('Ошибка сервера',500);
}
