import dns from 'node:dns/promises';
import net from 'node:net';

const isHttpUrl = (u) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } };
const cleanUrl = (u) => (u && isHttpUrl(u) ? u : '');

// ---------- Récupération des infos d'un lien (titre, image, prix) ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

async function assertPublicHost(url) {
  const { hostname } = new URL(url);
  const addrs = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Adresse non autorisée');
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function metaContent(html, keys) {
  for (const key of keys) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${key}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && m[1].trim()) return decodeEntities(m[1].trim());
  }
  return '';
}

function jsonLdProduct(html) {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, raw] of blocks) {
    try {
      let data = JSON.parse(raw.trim());
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const node = stack.shift();
        if (!node || typeof node !== 'object') continue;
        if (node['@graph']) stack.push(...node['@graph']);
        const type = [].concat(node['@type'] || []);
        if (type.includes('Product')) {
          const offer = [].concat(node.offers || [])[0] || {};
          const price = offer.price ?? offer.lowPrice ?? offer.offers?.[0]?.price;
          return {
            title: node.name || '',
            image: [].concat(node.image || [])[0]?.url || [].concat(node.image || [])[0] || '',
            price: price != null ? `${price} ${offer.priceCurrency || ''}`.trim() : '',
          };
        }
      }
    } catch { /* JSON-LD invalide : ignoré */ }
  }
  return null;
}

// Devine un titre lisible à partir du lien : /products/parfum-candy-cherry-921292362a03 → « Parfum candy cherry »
export function titleFromUrl(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean)
      .map((s) => { try { return decodeURIComponent(s); } catch { return s; } })
      .map((s) => s.replace(/\.(html?|php|aspx?)$/i, ''));
    const seg = [...segs].reverse().find((s) => /[a-z]{3,}/i.test(s) && s.includes('-')) || segs.at(-1) || '';
    const words = seg.split(/[-_+]+/).filter((w) => w && !/\d/.test(w) && !/^[a-f0-9]{6,}$/i.test(w));
    if (!words.length) return '';
    const t = words.join(' ').slice(0, 150);
    return t.charAt(0).toUpperCase() + t.slice(1);
  } catch { return ''; }
}

export async function fetchPreview(url) {
  let current = url;
  let res;
  for (let i = 0; i < 5; i++) {
    await assertPublicHost(current);
    res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    break;
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    const reason = res.status === 429 || res.status === 403
      ? 'ce site bloque la lecture automatique'
      : `le site a répondu ${res.status}`;
    throw new Error(reason);
  }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('html')) return { title: '', image: type.startsWith('image/') ? current : '', price: '' };

  // Lecture limitée à ~1,5 Mo
  const reader = res.body.getReader();
  let html = '';
  const decoder = new TextDecoder();
  while (html.length < 1_500_000) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  reader.cancel().catch(() => {});

  const ld = jsonLdProduct(html) || {};
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  let image = metaContent(html, ['og:image', 'og:image:url', 'twitter:image', 'image']) || ld.image || '';
  if (image) { try { image = new URL(image, current).toString(); } catch { image = ''; } }
  const amount = metaContent(html, ['product:price:amount', 'og:price:amount', 'price']);
  const currency = metaContent(html, ['product:price:currency', 'og:price:currency', 'priceCurrency']);

  return {
    title: (metaContent(html, ['og:title', 'twitter:title']) || ld.title || decodeEntities(titleTag.trim())).slice(0, 300),
    image: cleanUrl(image),
    price: amount ? `${amount} ${currency}`.trim() : (ld.price || ''),
  };
}
