// Tabs
const tabs = document.querySelectorAll('.tab');
const tabContents = document.querySelectorAll('.tab-content');
tabs.forEach((t) => t.addEventListener('click', () => {
  tabs.forEach((x) => x.classList.remove('active'));
  tabContents.forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById(`${t.dataset.tab}-tab`).classList.add('active');
}));

// Elements
const elApiKey = document.getElementById('openai-api-key');
const elSaveKey = document.getElementById('save-key-btn');
const elTestConn = document.getElementById('test-conn-btn');
const elStartAnalysis = document.getElementById('start-analysis-btn');
const elRefresh = document.getElementById('refresh-data-btn');
const elLoading = document.getElementById('loading');
const elGrid = document.getElementById('analysis-results');
const elDeepBtn = document.getElementById('run-deep-analysis-btn');
const elDeepOutput = document.getElementById('deep-analysis-output');

// Persist API key in localStorage
elApiKey.value = localStorage.getItem('openai_api_key') || '';
elSaveKey.addEventListener('click', () => {
  localStorage.setItem('openai_api_key', elApiKey.value.trim());
  alert('کلید ذخیره شد.');
});

elTestConn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/ping');
    const data = await res.json();
    alert(`اتصال سرور: ${data.status || 'ok'}`);
  } catch {
    alert('عدم اتصال به سرور');
  }
});

function formatRial(n) {
  try {
    return Number(n).toLocaleString('fa-IR');
  } catch {
    return String(n);
  }
}

async function fetchSnapshot() {
  const res = await fetch('/api/markets/snapshot', { cache: 'no-store' });
  if (!res.ok) throw new Error('snapshot failed');
  return res.json();
}

function renderSnapshot(snap) {
  elGrid.innerHTML = '';
  const { fx, crypto, meta } = snap;
  const cards = [];
  if (fx && fx.USD_IRR) {
    cards.push({ title: 'دلار به ریال (نرخ بازار)', value: `${formatRial(fx.USD_IRR.value)} ریال`, sub: fx.USD_IRR.source });
  }
  if (fx && fx.EUR_IRR) {
    cards.push({ title: 'یورو به ریال', value: `${formatRial(fx.EUR_IRR.value)} ریال`, sub: fx.EUR_IRR.source });
  }
  if (crypto && crypto.BTC_USD) {
    const btcIrr = Math.round(crypto.BTC_USD.value * (fx.USD_IRR?.value || 0));
    cards.push({ title: 'بیت‌کوین (ریال)', value: btcIrr ? `${formatRial(btcIrr)} ریال` : '—', sub: `BTC/USD: ${crypto.BTC_USD.value}` });
  }
  if (crypto && crypto.ETH_USD) {
    const ethIrr = Math.round(crypto.ETH_USD.value * (fx.USD_IRR?.value || 0));
    cards.push({ title: 'اتریوم (ریال)', value: ethIrr ? `${formatRial(ethIrr)} ریال` : '—', sub: `ETH/USD: ${crypto.ETH_USD.value}` });
  }
  if (meta) {
    cards.push({ title: 'به‌روز شدن', value: new Date(meta.ts).toLocaleString('fa-IR'), sub: meta.sources.join('، ') });
  }
  for (const c of cards) {
    const div = document.createElement('div');
    div.className = 'metric-card';
    div.innerHTML = `<h4>${c.title}</h4><div class="value">${c.value}</div><div class="sub">${c.sub || ''}</div>`;
    elGrid.appendChild(div);
  }
}

async function runSnapshot() {
  elLoading.classList.add('active');
  try {
    const snap = await fetchSnapshot();
    renderSnapshot(snap);
  } catch (e) {
    elGrid.innerHTML = '<div class="metric-card">خطا در دریافت داده بازار</div>';
  } finally {
    elLoading.classList.remove('active');
  }
}

elStartAnalysis.addEventListener('click', runSnapshot);
elRefresh.addEventListener('click', runSnapshot);

// History chart
let priceChart;
document.getElementById('show-history-btn').addEventListener('click', async () => {
  const date = document.getElementById('history-date').value;
  const time = document.getElementById('history-time').value;
  const res = await fetch(`/api/markets/history?symbol=USD_IRR&date=${encodeURIComponent(date)}&time=${encodeURIComponent(time)}`);
  const data = await res.json();
  const ctx = document.getElementById('price-chart').getContext('2d');
  const labels = data.points.map(p => new Date(p.ts).toLocaleTimeString('fa-IR'));
  const values = data.points.map(p => p.value);
  if (priceChart) priceChart.destroy();
  priceChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label: 'USD/IRR', data: values, borderColor: '#5b8cff', backgroundColor: 'rgba(91,140,255,0.15)'}] },
    options: { responsive: true, scales: { x: { display: true }, y: { display: true } } }
  });
});

// Patterns
document.getElementById('analyze-patterns-btn').addEventListener('click', async () => {
  const res = await fetch('/api/markets/patterns');
  const data = await res.json();
  const box = document.getElementById('pattern-results');
  box.innerHTML = `<h3>🎯 الگوهای معاملاتی شناسایی شده</h3><pre class="deep-output">${data.summary}</pre>`;
});

document.getElementById('generate-formula-btn').addEventListener('click', async () => {
  const res = await fetch('/api/markets/formula');
  const data = await res.json();
  alert(data.formula || '—');
});

// Recommendations
document.getElementById('generate-recs-btn').addEventListener('click', async () => {
  const res = await fetch('/api/markets/recommendations');
  const data = await res.json();
  document.getElementById('buy-recommendations').innerHTML = `<h3>🟢 پیشنهادات خرید</h3><ul>${data.buy.map(x=>`<li>${x}</li>`).join('')}</ul>`;
  document.getElementById('sell-recommendations').innerHTML = `<h3>🔴 پیشنهادات فروش</h3><ul>${data.sell.map(x=>`<li>${x}</li>`).join('')}</ul>`;
});

// Deep analysis via OpenAI
elDeepBtn.addEventListener('click', async () => {
  const key = (localStorage.getItem('openai_api_key') || '').trim();
  if (!key) { alert('ابتدا کلید API را ذخیره کنید.'); return; }
  elDeepOutput.textContent = 'در حال اجرای تحلیل عمیق بر پایه تجمیع داده و نظر اکثریت...';
  try {
    const snap = await fetchSnapshot();
    const res = await fetch('/api/deep-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        snapshot: snap,
        minutes_ahead: 10,
        // We pass key in header-like field inside body; server will not store it
        openai_api_key: key
      })
    });
    const data = await res.json();
    elDeepOutput.innerHTML = data.text ? data.text : 'پاسخی دریافت نشد';
  } catch (e) {
    elDeepOutput.textContent = 'خطا در تحلیل عمیق';
  }
});

