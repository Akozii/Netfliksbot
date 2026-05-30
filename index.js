import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { chromium } from 'playwright';

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const SENDER = 'info@account.netflix.com';
const SUBJECT_HINTS = ['hane', 'hanenizin', 'household', 'foyer', 'primary location'];

function extractHouseholdLink(html, text) {
  const hay = (html || '') + '\n' + (text || '');
  const matches = hay.match(/https?:\/\/[^\s"'<>)]+netflix\.com\/[^\s"'<>)]+/gi) || [];
  const clean = u => u.replace(/&amp;/g, '&').replace(/[.,)]+$/, '');
  for (const m of matches) {
    const u = clean(m);
    if (/update-primary-location/i.test(u) && /operation=update/i.test(u)) return u;
  }
  for (const m of matches) {
    const u = clean(m);
    if (/update-primary-location/i.test(u)) return u;
  }
  return null;
}

async function confirmInBrowser(link) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: 'tr-TR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  let result = 'bilinmiyor';
  try {
    await page.goto(link, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    const candidates = [
      '[data-uia*="set-primary-location-action"]',
      '[data-uia*="confirm"]',
      'button:has-text("Güncellemeyi Onayla")',
      'button:has-text("Onayla")',
      'button:has-text("Güncelle")',
      'button:has-text("Confirm Update")',
      'button:has-text("Confirm")',
      'button:has-text("Set Primary Location")',
      'button:has-text("Evet")',
      'button[type="submit"]'
    ];
    let clicked = false;
    for (const sel of candidates) {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 5000 }).catch(() => {});
        clicked = true;
        console.log('Tıklanan seçici: ' + sel);
        break;
      }
    }
    await page.waitForTimeout(4000);
    const body = (await page.textContent('body').catch(() => '')) || '';
    const ok = /onaylandı|güncellendi|tamamlandı|confirmed|updated|success|başarı/i.test(body);
    const expired = /süresi doldu|expired|geçersiz|invalid|yeniden gönder|resend/i.test(body);
    result = expired ? 'LİNK SÜRESİ DOLMUŞ'
      : clicked ? (ok ? 'BAŞARILI' : 'buton tıklandı (sonuç metni belirsiz)')
      : 'onay butonu bulunamadı';
    console.log('Sonuç: ' + result);
    await page.screenshot({ path: 'sonuc.png', fullPage: true }).catch(() => {});
  } catch (e) {
    result = 'HATA: ' + e.message;
    console.log(result);
    await page.screenshot({ path: 'hata.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
  return result;
}

async function main() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error('GMAIL_USER / GMAIL_APP_PASSWORD secret tanımlı değil.');
    process.exit(1);
  }
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }, logger: false
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const uids = await client.search({ seen: false, from: SENDER, since }, { uid: true });
    if (!uids || uids.length === 0) { console.log('Yeni Netflix maili yok.'); return; }

    const jobs = [];
    for (const uid of uids) {
      const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
      const subject = msg.envelope?.subject || '';
      if (!SUBJECT_HINTS.some(h => subject.toLowerCase().includes(h))) {
        console.log('Konu eşleşmedi: ' + subject); continue;
      }
      const parsed = await simpleParser(msg.source);
      const link = extractHouseholdLink(parsed.html, parsed.text);
      if (link) { console.log('Link bulundu (UID ' + uid + '): ' + link); jobs.push({ uid, link }); }
      else console.log('Link yok (UID ' + uid + '): ' + subject);
    }

    for (const { uid, link } of jobs) {
      const res = await confirmInBrowser(link);
      if (/BAŞARILI|tıklandı/i.test(res)) {
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
        console.log('Mail okundu işaretlendi (UID ' + uid + ').');
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  console.log('Bitti.');
}

main().catch(e => { console.error(e); process.exit(1); });
