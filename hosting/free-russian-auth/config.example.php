<?php
declare(strict_types=1);
// COPY THIS FILE TO ONE DIRECTORY ABOVE public_html:
// /home/ACCOUNT/matreshka-auth-config.php
// Never place secrets in public_html or GitHub.
return [
  'db_host' => 'localhost',
  'db_port' => 3306,
  'db_name' => 'YOUR_MYSQL_DB',
  'db_user' => 'YOUR_MYSQL_USER',
  'db_password' => 'YOUR_SECRET_PASSWORD',
  'secret' => 'REPLACE_WITH_64_RANDOM_HEX_CHARACTERS',
  'allowed_origin' => 'https://matreshka-v2.vercel.app',
];
