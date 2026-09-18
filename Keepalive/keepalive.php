<?php
/**
 * Keepalive PHP
 *
 * 用法：
 *   https://abc.serv00.net/keepalive.php?key=<访问密钥>&target=<目标地址>
 *
 * 示例：
 *   http://abc.ct8.pl/keepalive.php?key=admin123&target=http://abc.byethost5.com/manage_action.shtml?act=autostart
 *
 * 保活服务：
 *   CF Worker , Uptime Kuma , 或其他
 */

@set_time_limit(60);

// ─────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────
$SECRET  = 'admin123';   // 访问密钥
$TIMEOUT = 15;                              // 单次请求超时（秒）

// ─────────────────────────────────────────────
// 认证
// ─────────────────────────────────────────────
$key = $_GET['key'] ?? $_SERVER['HTTP_X_AUTH_KEY'] ?? '';
if (!hash_equals($SECRET, (string)$key)) {
    http_response_code(401);
    echo "unauthorized\n";
    exit;
}

// ─────────────────────────────────────────────
// 参数
// ─────────────────────────────────────────────
$target = $_GET['target'] ?? '';
if ($target === '') {
    http_response_code(400);
    echo "missing target\n";
    exit;
}
if (!preg_match('#^https?://#i', $target)) {
    http_response_code(400);
    echo "invalid target (must start with http:// or https://)\n";
    exit;
}

// ─────────────────────────────────────────────
// HTTP GET
// ─────────────────────────────────────────────
function http_get($url, $ua, $headers, $timeout) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_USERAGENT      => $ua,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_ENCODING       => '',
    ]);
    $body   = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err    = curl_error($ch);
    curl_close($ch);

    if ($body === false) {
        return ['status' => 0, 'body' => '', 'error' => $err ?: 'curl failed'];
    }
    return ['status' => $status, 'body' => $body, 'error' => null];
}

// ─────────────────────────────────────────────
// 带 aes.js 挑战处理的 GET
// ─────────────────────────────────────────────
function fetch_with_challenge($url, $timeout) {
    $ua = "Mozilla/5.0 (compatible; Let's Encrypt validation server; +https://www.letsencrypt.org)";
    $base_headers = [
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control: no-cache',
    ];

    // 第一次请求
    $r1 = http_get($url, $ua, $base_headers, $timeout);
    if ($r1['error']) {
        return ['status' => 0, 'ok' => false, 'error' => $r1['error'], 'challenged' => false];
    }

    $body1 = $r1['body'];
    $is_challenge = strpos($body1, 'aes.js') !== false || strpos($body1, 'slowAES') !== false;

    if (!$is_challenge) {
        $ok = $r1['status'] >= 200 && $r1['status'] < 400;
        return [
            'status'     => $r1['status'],
            'ok'         => $ok,
            'body'       => $body1,
            'challenged' => false,
        ];
    }

    // 解析 a/b/c
    if (!preg_match(
        '/a\s*=\s*toNumbers\("([0-9a-f]+)"\)\s*,\s*b\s*=\s*toNumbers\("([0-9a-f]+)"\)\s*,\s*c\s*=\s*toNumbers\("([0-9a-f]+)"\)/',
        $body1, $m
    )) {
        return ['status' => $r1['status'], 'ok' => false, 'error' => 'challenge parse failed', 'challenged' => true];
    }
    $aHex = $m[1]; $bHex = $m[2]; $cHex = $m[3];

    // cookie 名
    $cookieName = '__test';
    if (preg_match('/document\.cookie\s*=\s*"([^=]+)=/', $body1, $cm)) {
        $cookieName = $cm[1];
    }

    // AES-128-CBC 解密：key=a, iv=b, 无 padding
    $key = hex2bin($aHex);
    $iv  = hex2bin($bHex);
    $ct  = hex2bin($cHex);
    $options = OPENSSL_RAW_DATA | (defined('OPENSSL_NO_PADDING') ? OPENSSL_NO_PADDING : OPENSSL_ZERO_PADDING);
    $pt = @openssl_decrypt($ct, 'AES-128-CBC', $key, $options, $iv);
    if ($pt === false) {
        return ['status' => $r1['status'], 'ok' => false, 'error' => 'decrypt failed', 'challenged' => true];
    }
    $cookieValue = bin2hex($pt);

    // 第二次请求
    $step2_url = $url . (strpos($url, '?') !== false ? '&' : '?') . 'i=1';
    $headers2 = array_merge($base_headers, [
        'Referer: ' . $url,
        'Cookie: ' . $cookieName . '=' . $cookieValue,
    ]);
    $r2 = http_get($step2_url, $ua, $headers2, $timeout);
    if ($r2['error']) {
        return ['status' => 0, 'ok' => false, 'error' => 'step2: ' . $r2['error'], 'challenged' => true];
    }

    $still = strpos($r2['body'], 'aes.js') !== false;
    $ok = ($r2['status'] >= 200 && $r2['status'] < 400) && !$still;

    return [
        'status'     => $r2['status'],
        'ok'         => $ok,
        'body'       => $r2['body'],
        'challenged' => true,
        'still'      => $still,
    ];
}

// ─────────────────────────────────────────────
// 执行
// ─────────────────────────────────────────────
$r = fetch_with_challenge($target, $TIMEOUT);

header('Content-Type: text/plain; charset=utf-8');

$line = ($r['ok'] ? 'OK' : 'FAIL') . ' ' . $target . ' [' . ($r['status'] ?: 'ERR') . ']';
if (!empty($r['challenged'])) $line .= ' (challenge)';
if (!empty($r['error']))      $line .= ' ' . $r['error'];

echo $line . "\n";
if (!empty($r['body'])) {
    echo $r['body'];
    if (substr($r['body'], -1) !== "\n") echo "\n";
}
