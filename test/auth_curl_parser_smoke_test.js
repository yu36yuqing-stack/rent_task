const {
    parseUhaozuCurlAuthPayload,
    extractCurlMeta,
    buildUhaozuDefaultHeaders,
    parseUhaozuOrderDetailCurlPayload,
    buildUhaozuOrderDetailHeaders
} = require('../user/platform_auth_import_service');
const { _internals } = require('../uhaozu/uhaozu_api');

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected=${expected}, actual=${actual}`);
    }
}

function assertOk(value, msg) {
    if (!value) throw new Error(msg);
}

function assertThrows(fn, pattern, msg) {
    let thrown = null;
    try {
        fn();
    } catch (e) {
        thrown = e;
    }
    if (!thrown) throw new Error(`${msg}: expected throw`);
    if (pattern && !pattern.test(String(thrown.message || thrown))) {
        throw new Error(`${msg}: unexpected error=${thrown.message || thrown}`);
    }
}

const curl = `curl 'https://mapi.uhaozu.com/merchants/order/submit/orderList' \
  -H 'Cache-Control: no-cache' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' \
  -H 'sec-ch-ua: "Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"' \
  -H 'Content-Type: application/json;charset=UTF-8' \
  -H 'Referer: https://b.uhaozu.com/order' \
  -b 'foo=1; JSESSIONID=abc123; uid=user-token-xyz; bar=2' \
  --data-raw '{"pageNum":1}'`;

const meta = extractCurlMeta(curl);
assertEqual(meta.url, 'https://mapi.uhaozu.com/merchants/order/submit/orderList', 'extract url');
assertOk(/JSESSIONID=abc123/.test(meta.cookie), 'extract cookie');

const parsed = parseUhaozuCurlAuthPayload(curl);
assertEqual(parsed.auth_type, 'cookie', 'auth_type');
assertEqual(parsed.auth_status, 'valid', 'auth_status');
assertOk(parsed.auth_payload && /uid=user-token-xyz/.test(parsed.auth_payload.cookie), 'payload cookie');
assertOk(parsed.auth_payload && parsed.auth_payload.default_headers, 'payload default_headers');
assertEqual(parsed.auth_payload.default_headers['Cache-Control'], 'no-cache', 'default cache-control override');
assertEqual(parsed.auth_payload.default_headers['User-Agent'], 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36', 'default user-agent override');
assertEqual(parsed.auth_payload.default_headers['sec-ch-ua'], '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"', 'default sec-ch-ua override');
assertEqual(parsed.auth_payload.default_headers.Referer, 'https://b.uhaozu.com/order', 'default referer');

const headers = buildUhaozuDefaultHeaders(meta.headers);
assertEqual(headers['Cache-Control'], 'no-cache', 'headers cache-control override');
assertEqual(headers.Referer, 'https://b.uhaozu.com/order', 'headers referer');

const detailCurl = `curl 'https://www.uhaozu.com/order/usercenter/sellerOrderAccount/122377087088' \\
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7' \\
  -H 'Accept-Language: zh-CN,zh;q=0.9' \\
  -H 'Connection: keep-alive' \\
  -H 'Sec-Fetch-Dest: document' \\
  -H 'Sec-Fetch-Mode: navigate' \\
  -H 'Sec-Fetch-Site: none' \\
  -H 'Sec-Fetch-User: ?1' \\
  -H 'Upgrade-Insecure-Requests: 1' \\
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' \\
  -H 'sec-ch-ua: \"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Google Chrome\";v=\"146\"' \\
  -H 'sec-ch-ua-mobile: ?0' \\
  -H 'sec-ch-ua-platform: \"macOS\"' \\
  -b 'foo=1; JSESSIONID=detail123; uid=detail-user; oRiskDeviceCode=abc; bar=2'`;

const parsedDetail = parseUhaozuOrderDetailCurlPayload(detailCurl);
assertEqual(parsedDetail.order_detail_no, '122377087088', 'detail order no');
assertEqual(parsedDetail.order_detail_headers.Cookie, 'foo=1; JSESSIONID=detail123; uid=detail-user; oRiskDeviceCode=abc; bar=2', 'detail cookie');
assertEqual(parsedDetail.order_detail_headers.Connection, 'keep-alive', 'detail connection');
assertEqual(parsedDetail.order_detail_headers['Upgrade-Insecure-Requests'], '1', 'detail uir');

const detailHeaders = buildUhaozuOrderDetailHeaders(extractCurlMeta(detailCurl));
assertEqual(detailHeaders.Cookie, 'foo=1; JSESSIONID=detail123; uid=detail-user; oRiskDeviceCode=abc; bar=2', 'build detail cookie');

const runtimeDetailHeaders = _internals.buildOrderDetailHeaders(parsed.auth_payload.cookie, {
    ...parsed.auth_payload,
    order_detail_headers: parsedDetail.order_detail_headers
});
assertEqual(runtimeDetailHeaders.Cookie, 'foo=1; JSESSIONID=detail123; uid=detail-user; oRiskDeviceCode=abc; bar=2', 'runtime uses detail cookie');
assertEqual(runtimeDetailHeaders['Upgrade-Insecure-Requests'], '1', 'runtime uses detail navigation header');
assertEqual(runtimeDetailHeaders['User-Agent'], 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36', 'runtime uses detail user-agent');

assertThrows(
    () => parseUhaozuCurlAuthPayload(`curl 'https://example.com' -b 'uid=1; JSESSIONID=2'`),
    /不是 U号租商家后台请求/,
    'reject wrong host'
);

assertThrows(
    () => parseUhaozuCurlAuthPayload(`curl 'https://mapi.uhaozu.com/merchants/order/submit/orderList' -b 'uid=1'`),
    /JSESSIONID/,
    'reject missing jsession'
);

assertThrows(
    () => parseUhaozuOrderDetailCurlPayload(`curl 'https://www.uhaozu.com/order/usercenter/sellerOrderAccount/122377087088' -b 'uid=1'`),
    /JSESSIONID/,
    'reject detail missing jsession'
);

console.log('auth_curl_parser_smoke_test passed');
