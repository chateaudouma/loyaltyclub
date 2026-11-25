// Loyalty programme terms, written from the owner's live settings.
window.doumaMoney = (c, sym = '$') => `${c < 0 ? '-' : ''}${sym}${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
window.doumaTerms = function (s) {
  const m = (c) => window.doumaMoney(c, s.currency.symbol);
  const excl = s.categories.filter((c) => !c.eligible).map((c) => c.name);
  const items = [
    `Membership is free and open to guests aged 18 and over. One membership per person and per phone number.`,
    `Members earn cashback on eligible purchases at Château Douma: ${s.tiers.map((t) => `${t.name} ${t.rate}%`).join(', ')}.`,
    `Levels are based on cumulative eligible spending: ${s.tiers[1].name} from ${m(s.tiers[1].min)}, ${s.tiers[2].name} from ${m(s.tiers[2].min)}. Upgrades are automatic and apply to purchases after the upgrade. Levels do not expire.`,
    `Cashback is store credit in ${s.currency.code}. It can only be used at Château Douma, cannot be exchanged for cash and cannot be transferred to another person.`,
    `Cashback is calculated on the amount actually paid after discounts. No cashback is earned on the part of a bill paid with cashback, and cashback earned on a purchase can only be used on a later visit.`,
    excl.length ? `Not eligible for cashback: ${excl.join(', ')}. ${s.excludedProducts || ''}` : (s.excludedProducts || ''),
    `Cashback expires ${s.expiry.months} months after it is issued. We remind you before it expires. The oldest cashback is always used first.`,
    s.welcome.enabled ? `New members receive a ${m(s.welcome.amount)} welcome reward when they join, once per phone number. It can be used straight away and does not count towards level spending.` : '',
    s.birthday.enabled ? `Members who save their date of birth receive a ${m(s.birthday.amount)} birthday reward once a year, valid for ${s.birthday.validDays} days. The date of birth cannot be changed once saved.` : '',
    `Refunded purchases reverse the cashback and spending they generated. Cashback used on a refunded purchase is returned to your wallet. If cashback earned on a refunded purchase was already spent, its value is deducted from the refund.`,
    `Promotional campaigns run for limited dates (Beirut time) and do not combine unless stated.`,
    `Château Douma may correct errors and suspend memberships in case of misuse. Changes to these terms apply from the date they are published in the app.`,
  ].filter(Boolean);
  const extra = s.terms ? `<p style="margin-top:12px;white-space:pre-line">${String(s.terms).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>` : '';
  return `<ol style="padding-left:20px;margin:0;display:flex;flex-direction:column;gap:8px;font-size:14px;line-height:1.5">${items.map((i) => `<li>${i}</li>`).join('')}</ol>${extra}`;
};
