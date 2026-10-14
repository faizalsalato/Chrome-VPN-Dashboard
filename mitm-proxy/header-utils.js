/**
 * Utilities para reescrita de headers HTTP.
 */

const OS_HEADERS = {
  windows: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="131", "Not_A_Brand";v="8"',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-mobile': '?0',
    'Upgrade-Insecure-Requests': '1',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  macos: {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="131", "Not_A_Brand";v="8"',
    'sec-ch-ua-platform': '"macOS"',
    'sec-ch-ua-mobile': '?0',
    'Upgrade-Insecure-Requests': '1',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  linux: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="131", "Not_A_Brand";v="8"',
    'sec-ch-ua-platform': '"Ubuntu"',
    'sec-ch-ua-mobile': '?0',
    'Upgrade-Insecure-Requests': '1',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  },
  android: {
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'sec-ch-ua': '"Chromium";v="131", "Not_A_Brand";v="8"',
    'sec-ch-ua-platform': '"Android"',
    'sec-ch-ua-mobile': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  },
  ios: {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'sec-ch-ua': '"Chromium";v="131", "Not_A_Brand";v="8"',
    'sec-ch-ua-platform': '"iOS"',
    'sec-ch-ua-mobile': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  },
};

function getOsHeaders(os) {
  return { ...OS_HEADERS[os] || OS_HEADERS.windows };
}

function shouldSkipHost(host, skipHosts) {
  return skipHosts.some((h) => host === h || host.endsWith('.' + h));
}

function rewriteHeaders(headers, os, skipHosts) {
  const host = headers.host || headers.Host || '';
  if (shouldSkipHost(host, skipHosts)) return null;

  const osH = getOsHeaders(os);
  const out = { ...headers };

  if (osH.userAgent) out['User-Agent'] = osH.userAgent;
  if (osH['sec-ch-ua']) out['sec-ch-ua'] = osH['sec-ch-ua'];
  if (osH['sec-ch-ua-platform']) out['sec-ch-ua-platform'] = osH['sec-ch-ua-platform'];
  if (osH['sec-ch-ua-mobile']) out['sec-ch-ua-mobile'] = osH['sec-ch-ua-mobile'];
  if (osH['Upgrade-Insecure-Requests']) out['Upgrade-Insecure-Requests'] = osH['Upgrade-Insecure-Requests'];
  if (osH['Accept-Language']) out['Accept-Language'] = osH['Accept-Language'];

  return out;
}

module.exports = { rewriteHeaders, shouldSkipHost, getOsHeaders, OS_HEADERS };
