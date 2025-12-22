
// そろばん 読み上げ算 練習ツール（統合最終版）
// ・音声初期化強化（onvoiceschanged待機＋発話アンロック）
// ・読み：同符号連続時は符合語省略／最後は「円、でわ」を連続
// ・数字：漢数字読み時に 兆・億・万 の直後へ極短ポーズ（問題=100ms／答え=150ms）
// ・復習：回答リストから単体再読上
// ・タイマー：第1問開始→答え発表「直前」までの所要時間をログ表示
// ・採点UI：答え発表後にまとめて自己採点（ラジオ選択）→CSVダウンロード
// ・CSV：英語ヘッダー／UTF-8 BOM付与／ファイル名に開始時刻（なければダウンロード時刻）
// ・減算ロジック：減算総数≤40%、最初の2口は加算固定、最初の口以下に落ちる減算は禁止
// ・既存の不自然制約（直前口80%／途中下限）は完全削除

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
    if (!problemIntervalInput.value ||
        Number.isNaN(parseFloat(problemIntervalInput.value))) {
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

// ★追加：タイマー用（第1問開始～答え発表直前）
let startTime = null;          // performance.now() 用（経過秒）
let startDateTime = null;      // Date オブジェクトで開始時刻を保持（ファイル名用）

// ★追加：直近の出題セットと設定（復習・CSV用）
let lastRunProblems = [];
let lastRunSettings = null;
let reviewing = false; // 復習中の二重起動防止

// ★追加：採点結果保持
let resultsLog = []; // { index, steps, answer, score }

// ★追加：時刻フォーマッタ（YYYYMMDD_HHMMSS）
function formatDateTime(dt) {
  const pad = n => String(n).padStart(2, '0');
  const yyyy = dt.getFullYear();
  const mm = pad(dt.getMonth() + 1);
  const dd = pad(dt.getDate());
  const HH = pad(dt.getHours());
  const MM = pad(dt.getMinutes());
  const SS = pad(dt.getSeconds());
  return `${yyyy}${mm}${dd}_${HH}${MM}${SS}`;
}

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
  selectedVoice = voices[voiceSelect.value] ?? null;
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
voiceSelect.addEventListener('change', () => { selectedVoice = voices[voiceSelect.value] ?? null; });
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

  // 復習・CSV用に保持
  lastRunProblems = problems;
  lastRunSettings = settings;
  resultsLog = []; // 新規開始時にクリア

  // ★タイマー開始（第1問に入る前）
  startTime = performance.now();
  // ★開始時刻（Date）を保持（ファイル名に利用）
  startDateTime = new Date();

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
      // ★答え発表「直前」でタイマー停止＆ログ出力
      const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(1);
      logArea.textContent += `所要時間: ${elapsedSec} 秒\n\n`;

      // 従来通り：最終問題から答え発表までの待機 = 問題間隔
      await delay(Math.max(0, settings.problemInterval) * 1000);

      // 答えの発表（既存処理）
      await speak('答えの発表です。', baseVoiceParams());

      // 回答リスト生成（クリックで復習可能）
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

      // ★採点UI（まとめて入力）を表示
      showScoringUI(problems);
    }
  } finally {
    running = false; toggleRunButtons(false);
  }
});

// ---------- 設定／ユーティリティ ----------
function readSettings() {
  return {
    digits: clamp(parseInt(digitsInput.value), 1, 12), // 最小1桁
    kousu: clamp(parseInt(kousuInput.value), 1, 50),
    problemCount: clamp(parseInt(problemCountInput.value), 1, 10),
    mode: modeSelect.value,   // 'plus' or 'mix'
    rate: parseFloat(rateInput.value),
    pitch: parseFloat(pitchInput.value),
    stepInterval: parseFloat(stepIntervalInput.value),
    problemInterval: parseFloat(problemIntervalInput.value),
    useKanji: useKanjiCheck.checked,
  };
}
function baseVoiceParams() { const v = selectedVoice; return { rate: parseFloat(rateInput.value), pitch: parseFloat(pitchInput.value), voice: v }; }
function toggleRunButtons(isRunning) { startBtn.disabled = isRunning; pauseBtn.disabled = !isRunning; resumeBtn.disabled = !isRunning; stopBtn.disabled = !isRunning; }
function clearUI() { 
  logArea.textContent = ''; 
  answersList.innerHTML = ''; 
  const old = document.getElementById('scoringArea'); 
  if (old) old.remove(); 
}
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
function randomNDigits(n) { 
  if (n === 1) return Math.floor(Math.random() * 9) + 1; // 1桁は 1-9
  const min = 10 ** (n - 1); 
  const max = 10 ** n - 1; 
  return Math.floor(Math.random() * (max - min + 1)) + min; 
}

// ---------- 出題ロジック（減算上限40%／1・2口加算固定／最初の口以下は禁止） ----------
function generateProblem(settings) {
  const steps = [];
  let sum = 0;
  let firstStepValue = null;                 // 最初の口の値（比較用）
  const maxMinusCount = Math.floor(settings.kousu * 0.4);
  let minusCount = 0;

  for (let i = 0; i < settings.kousu; i++) {
    let value = randomNDigits(settings.digits);
    let op = '+';

    // 1・2口目は必ず足し算
    if (i < 2) {
      op = '+';
    } else if (settings.mode === 'mix') {
      // 減算候補（従来同様の軽い確率）
      const wantMinus = Math.random() < 0.3;

      if (wantMinus && minusCount < maxMinusCount) {
        // 仮に減算した場合の合計
        const wouldBe = sum - value;

        // ★新ルール：最初の口の数字以下になるなら減算禁止（加算へ変更）
        const threshold = firstStepValue ?? 0;
        if (wouldBe > threshold) {
          op = '-';
        } else {
          op = '+';
        }
      } else {
        op = '+';
      }
    }

    // 合計更新
    if (op === '+') {
      sum += value;
    } else {
      sum -= value;
      minusCount++;
    }

    if (i === 0) firstStepValue = value;
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

// ---------- 採点UI／CSV ----------

// 採点フォームをログ欄に生成（まとめて入力）
function showScoringUI(problems) {
  const scoringDiv = document.createElement('div');
  scoringDiv.id = 'scoringArea';
  scoringDiv.style.marginTop = '20px';
  scoringDiv.innerHTML = '<h3>採点入力（まとめて）</h3>';

  problems.forEach((p, idx) => {
    const wrapper = document.createElement('div');
    wrapper.style.marginBottom = '8px';
    wrapper.innerHTML = `
      <label>第${idx + 1}問（答え: ${p.result}）</label><br>
      <input type="radio" name="score${idx}" value="1発正解">1発正解
      <input type="radio" name="score${idx}" value="2回目正解">2回目正解
      <input type="radio" name="score${idx}" value="2回以上間違い">2回以上間違い
    `;
    scoringDiv.appendChild(wrapper);
  });

  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'CSVで保存';
  exportBtn.style.marginTop = '12px';
  exportBtn.addEventListener('click', () => {
    collectScores(problems);
    exportCSV();
  });

  scoringDiv.appendChild(exportBtn);
  logArea.appendChild(scoringDiv);
}

// ラジオ選択の採点結果を収集
function collectScores(problems) {
  resultsLog = [];
  problems.forEach((p, idx) => {
    const radios = document.getElementsByName(`score${idx}`);
    let selected = '';
    Array.from(radios).forEach(r => { if (r.checked) selected = r.value; });
    resultsLog.push({
      index: idx + 1,
      steps: p.steps.map(s => `${s.op}${s.value}`).join(','),
      answer: p.result,
      score: selected || '未入力'
    });
  });
}


// CSVを生成してダウンロード（英語ヘッダー／BOM付与／時刻付きファイル名）
function exportCSV() {
  // 文字化け対策：UTF-8 BOM 付与
  const BOM = '\uFEFF';

  // 英語ヘッダー（StepInterval／ProblemInterval を追加）
  const header = [
    'Date',            // 例: ローカライズ表示（toLocaleDateString）
    'Digits',
    'Kousu',
    'ProblemCount',
    'Mode',
    'Rate',
    'StepInterval',    // ★追加：各口のインターバル（秒）
    'ProblemInterval', // ★追加：問題間のインターバル（秒）
    'ProblemIndex',
    'Steps',           // カンマ区切りのためフィールドはダブルクォートで括る
    'Answer',
    'SelfScore'        // FirstTryCorrect / SecondTryCorrect / MoreThanTwoMistakes / Unfilled
  ];

  // 日本語スコア→英語に変換
  const scoreMap = {
    '1発正解': 'FirstTryCorrect',
    '2回目正解': 'SecondTryCorrect',
    '2回以上間違い': 'MoreThanTwoMistakes',
    '未入力': 'Unfilled'
  };

  const rows = resultsLog.map(r => [
    new Date().toLocaleDateString(),         // Date（ローカライズ）
    lastRunSettings.digits,
    lastRunSettings.kousu,
    lastRunSettings.problemCount,
    lastRunSettings.mode,
    lastRunSettings.rate,
    lastRunSettings.stepInterval,            // ★追加：各口インターバル
    lastRunSettings.problemInterval,         // ★追加：問題間インターバル
    r.index,
    `"${r.steps}"`,                           // ステップにカンマが含まれるためクォート
    r.answer,
    scoreMap[r.score] ?? 'Unfilled'
  ]);

  const csvContent = [header.join(','), ...rows.map(row => row.join(','))].join('\n');

  // 開始時刻（第1問開始）を優先／無ければダウンロード時刻
  const ts = startDateTime ? formatDateTime(startDateTime) : formatDateTime(new Date());
  const filename = `soroban_log_${ts}.csv`;

  // ダウンロード（BOM付きUTF-8）
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();

  // 後片付け（任意）
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
