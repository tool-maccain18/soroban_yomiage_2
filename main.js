
// そろばん 読み上げ算 練習ツール（最終版 + レビュー機能）
// ・音声初期化強化（onvoiceschanged待機＋発話アンロック）
// ・読み：同符号連続時は符合語省略／最後は「円、でわ」を連続
// ・数字：漢数字読み時に 兆・億・万 の直後へ極短ポーズ（問題=100ms／答え=150ms）
// ・出題：減算はスムーズ（直前口の絶対値×0.8以下）、途中合計が「設定桁数から2桁下」を下回らないよう制御
// ・追加：回答リストから問題をクリックして単体再読上（復習）／答え発表前の間隔=問題間隔
// ・標準問題間隔：初期値 10 秒

// ---------- DOM 参照 ----------
const voiceSelect = document.getElementById('voiceSelect');
const refreshVoicesBtn = document.getElementById('refreshVoices');
const initVoiceBtn = document.getElementById('initVoiceBtn');
const testSpeakBtn = document.getElementById('testSpeakBtn');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const stopBtn = document.getElementById('stopBtn');
const previewBtn = document.getElementById('previewBtn');
const digitsInput = document.getElementById('digits');
const kousuInput = document.getElementById('kousu');
const problemCountInput = document.getElementById('problemCount');
const modeSelect = document.getElementById('mode');
const rateInput = document.getElementById('rate');
const pitchInput = document.getElementById('pitch');
const stepIntervalInput = document.getElementById('stepInterval');
const problemIntervalInput = document.getElementById('problemInterval');
const useKanjiCheck = document.getElementById('useKanji');
const logArea = document.getElementById('logArea');
const answersList = document.getElementById('answers');

// 標準の問題間隔（回答記入時間を考慮した 10 秒）
document.addEventListener('DOMContentLoaded', () => {
  try {
    if (!problemIntervalInput.value || Number.isNaN(parseFloat(problemIntervalInput.value))) {
      problemIntervalInput.value = '10';
    }
  } catch {}
});

// ---------- 状態 ----------
let voices = [];
let selectedVoice = null;
let running = false;
let cancelled = false;
let voicesReady = false;
// 追加：直近の出題セットと設定（復習用）
let lastRunProblems = [];
let lastRunSettings = null;
let reviewing = false; // 復習中の二重起動防止

// ---------- 音声初期化（強化） ----------
function populateVoices() {
  voices = window.speechSynthesis.getVoices();
  voiceSelect.innerHTML = '';
  voices.forEach((v, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelect.appendChild(opt);
  });
  const jaIndex = voices.findIndex(v => v.lang && v.lang.toLowerCase().startsWith('ja'));
  voiceSelect.value = jaIndex >= 0 ? jaIndex : 0;
  selectedVoice = voices[voiceSelect.value] || null;
  voicesReady = voices.length > 0;
}
async function ensureVoices(timeoutMs = 2000) {
  populateVoices();
  if (voicesReady) return true;
  const start = performance.now();
  return await new Promise(resolve => {
    const handler = () => {
      populateVoices();
      resolve(true);
      window.speechSynthesis.onvoiceschanged = null;
    };
    window.speechSynthesis.onvoiceschanged = handler;
    const tick = () => {
      if (voicesReady) { window.speechSynthesis.onvoiceschanged = null; resolve(true); return; }
      if (performance.now() - start > timeoutMs) { window.speechSynthesis.onvoiceschanged = null; resolve(false); return; }
      setTimeout(tick, 100);
    };
    tick();
  });
}
async function initVoicesFlow() {
  try { window.speechSynthesis.cancel(); } catch {}
  const ok = await ensureVoices(2500);
  if (!ok) {
    try { await speak('テスト', baseVoiceParams()); } catch {}
    populateVoices();
  }
  const ready = voicesReady && selectedVoice;
  testSpeakBtn.disabled = !ready;
  startBtn.disabled = !ready;
  previewBtn.disabled = !ready;
  return ready;
}
window.speechSynthesis.onvoiceschanged = () => { populateVoices(); };
refreshVoicesBtn.addEventListener('click', () => { populateVoices(); });
voiceSelect.addEventListener('change', () => { selectedVoice = voices[voiceSelect.value] || null; });
initVoiceBtn.addEventListener('click', async () => {
  const ready = await initVoicesFlow();
  if (ready) {
    try { await speak('音声の初期化が完了しました。', baseVoiceParams()); } catch {}
  }
});
testSpeakBtn.addEventListener('click', async () => {
  await speak('テスト発話です。', baseVoiceParams());
});
pauseBtn.addEventListener('click', () => { window.speechSynthesis.pause(); });
resumeBtn.addEventListener('click', () => { window.speechSynthesis.resume(); });
stopBtn.addEventListener('click', () => {
  cancelled = true; window.speechSynthesis.cancel(); running = false; toggleRunButtons(false);
});

// ---------- 1口プレビュー（単位ポーズ付き） ----------
previewBtn.addEventListener('click', async () => {
  const num = randomNDigits(parseInt(digitsInput.value));
  await speakNumberWithUnitPauses(num, useKanjiCheck.checked, '円なりー、', baseVoiceParams(), 100);
});

// ---------- 回答リストでクリック復習（イベント委譲） ----------
answersList.addEventListener('click', async (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const idx = parseInt(li.dataset.index, 10);
  if (!Number.isInteger(idx)) return;
  if (!lastRunProblems.length || !lastRunSettings) return;
  await readSingleProblem(idx, lastRunSettings);
});

// ---------- 本編開始 ----------
startBtn.addEventListener('click', async () => {
  if (running) return;
  cancelled = false; running = true; toggleRunButtons(true); clearUI();
  const settings = readSettings();
  const problems = Array.from({ length: settings.problemCount }, () => generateProblem(settings));
  // 復習用に保持
  lastRunProblems = problems;
  lastRunSettings = settings;

  // ログ出力（式）
  problems.forEach((p, idx) => {
    logArea.textContent += `第${idx + 1}問\n`;
    logArea.textContent += p.steps.map(s => `${s.op === '+' ? '+' : '-'} ${s.value}`).join('\n');
    logArea.textContent += `\n\n`;
  });

  try {
    for (let i = 0; i < problems.length; i++) {
      if (cancelled) break;
      await speak(`第${i + 1}問`, baseVoiceParams());
      await playProblem(problems[i], settings);
      if (i < problems.length - 1) await delay(settings.problemInterval * 1000);
    }
    if (!cancelled) {
      // ★ 変更点：最後の問題から答え発表までの待ち時間 = 問題間隔
      await delay(Math.max(0, settings.problemInterval) * 1000);
      await speak('答えの発表です。', baseVoiceParams());

      // 回答リストを生成（クリックで復習できるよう data-index を付与）
      problems.forEach((p, idx) => {
        const li = document.createElement('li');
        li.textContent = `第${idx + 1}問： ${p.result}`;
        li.dataset.index = String(idx);
        li.title = 'クリックするとこの問題をもう一度読み上げます';
        answersList.appendChild(li);
      });
      // 答えの読み上げ（従来通り）
      for (let i = 0; i < problems.length; i++) {
        await speak(`第${i + 1}問、`, baseVoiceParams());
        await speakNumberWithUnitPauses(problems[i].result, useKanjiCheck.checked, '', baseVoiceParams(), 150);
      }
    }
  } finally {
    running = false; toggleRunButtons(false);
  }
});

// ---------- 設定／ユーティリティ ----------
function readSettings() {
  return {
    digits: clamp(parseInt(digitsInput.value), 2, 12),
    kousu: clamp(parseInt(kousuInput.value), 1, 50),
    problemCount: clamp(parseInt(problemCountInput.value), 1, 10),
    mode: modeSelect.value,
    rate: parseFloat(rateInput.value),
    pitch: parseFloat(pitchInput.value),
    stepInterval: parseFloat(stepIntervalInput.value),
    problemInterval: parseFloat(problemIntervalInput.value),
    useKanji: useKanjiCheck.checked,
  };
}
function baseVoiceParams() { const v = selectedVoice; return { rate: parseFloat(rateInput.value), pitch: parseFloat(pitchInput.value), voice: v }; }
function toggleRunButtons(isRunning) { startBtn.disabled = isRunning; pauseBtn.disabled = !isRunning; resumeBtn.disabled = !isRunning; stopBtn.disabled = !isRunning; }
function clearUI() { logArea.textContent = ''; answersList.innerHTML = ''; }
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }
function speak(text, { rate = 1.0, pitch = 1.0, voice = null } = {}) {
  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = rate; utter.pitch = pitch;
    if (voice) utter.voice = voice;
    utter.lang = (voice && voice.lang) ? voice.lang : 'ja-JP';
    utter.onend = () => resolve();
    utter.onerror = () => resolve(); // 失敗しても進行停止しない
    try { window.speechSynthesis.speak(utter); } catch (e) { resolve(); }
  });
}
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
function randomNDigits(n) { const min = 10 ** (n - 1); const max = 10 ** n - 1; return Math.floor(Math.random() * (max - min + 1)) + min; }

// ---------- 出題ロジック（減算のスムーズ＋途中下限：設定桁数から2桁下） ----------
function generateProblem(settings) {
  const SMOOTH_MINUS_FACTOR = 0.8; // 減算値は直前口の絶対値×0.8以下
  const LOWER_BOUND = Math.pow(10, Math.max(0, settings.digits - 2)); // 途中合計はこの下限未満にしない
  const steps = [];
  let sum = 0;
  let prevAbs = null; // 直前の口の絶対値
  for (let i = 0; i < settings.kousu; i++) {
    let value = randomNDigits(settings.digits);
    let op = '+';
    if (settings.mode === 'mix') {
      const tryMinus = Math.random() < 0.3;
      if (tryMinus && sum > 0) {
        // 基本：少なくとも 1 を残す（ゼロ回避）
        let maxDec = sum - 1;
        // 動的下限：sum - value >= LOWER_BOUND → value <= sum - LOWER_BOUND
        maxDec = Math.min(maxDec, sum - LOWER_BOUND);
        // スムーズ制約：直前口の 80% 以下
        if (prevAbs !== null) {
          const smoothCap = Math.floor(prevAbs * SMOOTH_MINUS_FACTOR);
          maxDec = Math.min(maxDec, smoothCap);
        }
        if (maxDec >= 1) {
          op = '-';
          value = Math.min(value, maxDec);
          if (value <= 0) value = Math.floor(Math.random() * maxDec) + 1;
        }
      }
    }
    if (op === '+') sum += value; else sum -= value;
    prevAbs = Math.abs(value);
    steps.push({ op, value });
  }
  return { steps, result: sum };
}

// ---------- 漢数字の単位ポーズ（兆・億・万） ----------
function splitKanjiByBigUnits(kanjiStr) {
  const units = ['兆', '億', '万'];
  const parts = []; let buf = '';
  for (let i = 0; i < kanjiStr.length; i++) {
    buf += kanjiStr[i];
    if (units.includes(kanjiStr[i])) { parts.push(buf); buf = ''; }
  }
  if (buf) parts.push(buf);
  return parts;
}
async function speakNumberWithUnitPauses(n, useKanji, tail, voiceParams, unitPauseMs = 120) {
  if (!useKanji) { await speak(String(n) + tail, voiceParams); return; }
  const k = toKanjiNumber(n);
  const parts = splitKanjiByBigUnits(k);
  if (parts.length <= 1) { await speak(k + tail, voiceParams); return; }
  for (let i = 0; i < parts.length; i++) {
    const isLast = (i === parts.length - 1);
    const text = isLast ? (parts[i] + tail) : parts[i];
    await speak(text, voiceParams);
    if (!isLast) await delay(unitPauseMs);
  }
}

// ---------- 読み（符合と言語尾） ----------
async function playProblem(problem, settings) {
  for (let i = 0; i < problem.steps.length; i++) {
    const step = problem.steps[i];
    const prev = i > 0 ? problem.steps[i - 1] : null;
    const last = (i === problem.steps.length - 1);
    const needsPrefix = i > 0 && ((prev.op === '+') !== (step.op === '+'));
    const prefix = needsPrefix ? (step.op === '+' ? 'くわえて ' : 'とってわ ') : '';
    if (prefix) { await speak(prefix, baseVoiceParams()); }
    const tail = last ? '円、でわ' : '円なりー、';
    await speakNumberWithUnitPauses(step.value, settings.useKanji, tail, baseVoiceParams(), 100);
    if (!last) await delay(settings.stepInterval * 1000);
  }
}

function formatNumber(n, useKanji) { return useKanji ? toKanjiNumber(n) : String(n); }

// ---------- 簡易漢数字化（万・億・兆・京まで） ----------
function toKanjiNumber(num) {
  if (num === 0) return '零';
  const small = ['', '十', '百', '千'];
  const big = ['', '万', '億', '兆', '京'];
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  let s = String(num);
  const groups = [];
  while (s.length > 0) { groups.unshift(s.slice(-4)); s = s.slice(0, -4); }
  let out = '';
  groups.forEach((grp, gi) => {
    let part = '';
    const g = grp.padStart(4, '0').split('').map(d => parseInt(d));
    for (let i = 0; i < 4; i++) {
      const d = g[i];
      if (d === 0) continue;
      if (i === 0 && d === 1) part += small[3];
      else if (i === 1 && d === 1) part += small[2];
      else if (i === 2 && d === 1) part += small[1];
      else part += digits[d] + small[3 - i];
    }
    if (part) part += big[groups.length - gi - 1];
    out += part;
  });
  return out || '零';
}

// ---------- 単体復習読み上げ ----------
async function readSingleProblem(index, settings) {
  if (reviewing) return; // 二重起動防止
  const problem = lastRunProblems[index];
  if (!problem) return;
  try {
    reviewing = true;
    await speak(`第${index + 1}問、復習です。`, baseVoiceParams());
    await playProblem(problem, settings);
  } finally {
    reviewing = false;
  }
}
