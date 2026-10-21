const state = {
  phase: "idle",
  sourceUrl: null,
  savedAt: null,
  styleKey: "musicbox",
  audioContext: null,
  analyser: null,
  mediaStream: null,
  mediaRecorder: null,
  chunks: [],
  recordingStartedAt: 0,
  timerId: null,
  visualId: null,
  recordingBlob: null,
  recordingBuffer: null,
  events: [],
  songBlob: null,
  songUrl: null,
  level: 0,
};

const dom = {
  body: document.body,
  canvas: document.querySelector("#visualizer"),
  recordButton: document.querySelector("#recordButton"),
  recordButtonText: document.querySelector("#recordButtonText"),
  recordStatus: document.querySelector("#recordStatus"),
  audioFile: document.querySelector("#audioFile"),
  importLabel: document.querySelector("#importLabel"),
  sourceSection: document.querySelector("#sourceSection"),
  sourcePlayer: document.querySelector("#sourcePlayer"),
  sourceDownload: document.querySelector("#sourceDownload"),
  clearButton: document.querySelector("#clearButton"),
  settings: document.querySelector("#settings"),
  resultSection: document.querySelector("#resultSection"),
  songDate: document.querySelector("#songDate"),
  timer: document.querySelector("#timer"),
  recordHint: document.querySelector("#recordHint"),
  makeButton: document.querySelector("#makeButton"),
  includeVoice: document.querySelector("#includeVoice"),
  eventCount: document.querySelector("#eventCount"),
  songState: document.querySelector("#songState"),
  player: document.querySelector("#player"),
  downloadLink: document.querySelector("#downloadLink"),
  shareButton: document.querySelector("#shareButton"),
  toast: document.querySelector("#toast"),
};

const styles = {
  musicbox: { label: "오르골", tempo: 92, noteOffset: 12, chordGain: 0.08, melodyGain: 0.25 },
  lullaby: { label: "자장가", tempo: 72, noteOffset: 0, chordGain: 0.11, melodyGain: 0.21 },
  lofi: { label: "로파이", tempo: 82, noteOffset: -2, chordGain: 0.1, melodyGain: 0.22 },
};

const sampleRate = 44100;
const scale = [0, 2, 4, 7, 9, 12, 14, 16];
const maxSeconds = 60;
window.lucide?.createIcons();
let databasePromise;
let saveQueue = Promise.resolve();

dom.recordButton.addEventListener("click", () => {
  if (state.phase === "recording") {
    stopRecording();
  } else {
    if (!isBusy()) startRecording();
  }
});

dom.makeButton.addEventListener("click", async () => {
  await makeSong();
});

dom.shareButton.addEventListener("click", async () => {
  await shareSong();
});

dom.audioFile.addEventListener("change", async () => {
  const file = dom.audioFile.files[0];
  dom.audioFile.value = "";
  if (!file || isBusy()) return;
  if (file.size > 15 * 1024 * 1024) {
    showToast("15MB 이하의 짧은 녹음 파일을 골라 주세요.");
    return;
  }
  setPhase("processing");
  try {
    await acceptRecording(file);
    await persistSession();
  } catch (error) {
    showToast(error.message || "이 파일을 읽지 못했어요.");
  } finally {
    setPhase("idle");
  }
});

dom.clearButton.addEventListener("click", async () => {
  if (isBusy()) return;
  setPhase("processing");
  resetSong();
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  state.sourceUrl = null;
  state.recordingBlob = null;
  dom.sourcePlayer.removeAttribute("src");
  dom.sourcePlayer.load();
  dom.sourceSection.hidden = true;
  dom.timer.textContent = "00:00";
  dom.recordHint.textContent = "짧은 옹알이도 좋아요.";
  await persistSession();
  drawIdleVisualizer();
  setPhase("idle");
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.phase === "recording") stopRecording();
});
window.addEventListener("pagehide", () => {
  if (state.phase === "recording") stopRecording();
});

window.addEventListener("load", async () => {
  drawIdleVisualizer();
  registerServiceWorker();
  setPhase("processing");
  try {
    const saved = await readSession();
    const recording = saved?.recordingData ? new Blob([saved.recordingData], { type: saved.recordingType }) : saved?.recordingBlob;
    if (recording) {
      await acceptRecording(recording);
      const key = styles[saved.styleKey] ? saved.styleKey : "musicbox";
      document.querySelector(`input[value='${key}']`).checked = true;
      dom.includeVoice.checked = saved.includeVoice !== false;
      if (saved.songData || saved.songBlob) {
        state.songBlob = saved.songData ? new Blob([saved.songData], { type: "audio/wav" }) : saved.songBlob;
        state.savedAt = saved.savedAt;
        state.styleKey = key;
        displaySong();
      }
      dom.recordHint.textContent = "최근 녹음을 다시 불러왔어요.";
    }
  } catch {
    showToast("기기 보관함을 열지 못했어요. 녹음과 음악 만들기는 사용할 수 있어요.");
  } finally {
    setPhase("idle");
  }
});

function isBusy() { return state.phase !== "idle"; }

function setPhase(phase) {
  state.phase = phase;
  const recording = phase === "recording";
  dom.body.classList.toggle("is-recording", recording);
  dom.recordButton.disabled = phase !== "idle" && !recording;
  dom.audioFile.disabled = isBusy();
  dom.importLabel.classList.toggle("disabled", isBusy());
  dom.settings.disabled = isBusy();
  dom.clearButton.disabled = isBusy();
  dom.makeButton.disabled = isBusy() || !state.events.length;
  dom.recordButtonText.textContent = recording ? "녹음 멈추기" : phase === "requesting" ? "마이크 연결 중" : "녹음 시작";
  dom.makeButton.textContent = phase === "rendering" ? "만드는 중" : state.songBlob ? "다시 만들기" : "음악 만들기";
  dom.recordStatus.textContent = ({ idle: state.recordingBuffer ? "녹음 완료" : "녹음 준비", requesting: "연결 중", recording: "녹음 중", processing: "분석 중", rendering: "음악 생성 중" })[phase];
}

async function startRecording() {
  setPhase("requesting");
  let stream;
  let context;
  try {
    if (!window.isSecureContext) {
      throw new Error("아이폰 녹음은 https 주소에서 열어 주세요. 녹음 파일은 불러올 수 있어요.");
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error("이 브라우저는 녹음을 지원하지 않아요. 녹음 파일을 불러와 주세요.");
    }
    dom.sourcePlayer.pause();
    dom.player.pause();
    context = new AudioContext();
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (document.hidden) throw new Error("화면을 열어 둔 상태에서 녹음해 주세요.");
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.chunks = [];
    state.mediaStream = stream;
    state.audioContext = context;
    state.analyser = analyser;
    state.mediaRecorder = recorder;

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        state.chunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", () => handleRecordingStopped(recorder, state.chunks.slice()), { once: true });
    recorder.addEventListener("error", () => {
      showToast("녹음이 중단됐어요. 다시 시도해 주세요.");
      stopRecording();
    });
    stream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => {
      if (state.phase === "recording") stopRecording();
    }));
    recorder.start(1000);

    state.recordingStartedAt = performance.now();
    state.timerId = window.setInterval(updateTimer, 200);
    setPhase("recording");
    dom.recordHint.textContent = "소리를 듣고 있어요. 화면을 열어 두세요.";
    drawLiveVisualizer();
    updateTimer();
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    await context?.close().catch(() => {});
    state.mediaRecorder = null;
    state.audioContext = null;
    state.mediaStream = null;
    setPhase("idle");
    showToast(error.name === "NotAllowedError" ? "마이크 사용이 허용되지 않았어요. Safari의 웹사이트 설정에서 마이크를 허용해 주세요." : error.message || "마이크에 연결하지 못했어요.");
  }
}

function stopRecording() {
  if (state.phase !== "recording") return;
  setPhase("processing");
  if (state.mediaRecorder?.state === "recording") {
    state.mediaRecorder.stop();
  }

  state.mediaStream?.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
  window.clearInterval(state.timerId);
  cancelAnimationFrame(state.visualId);
  dom.recordHint.textContent = "분석 중이에요. 잠깐만 기다려 주세요.";
}

async function handleRecordingStopped(recorder, chunks) {
  try {
    await acceptRecording(new Blob(chunks, { type: recorder.mimeType || "audio/mp4" }));
    await persistSession();
  } catch (error) {
    dom.recordHint.textContent = "녹음을 다시 시도해 주세요. 이전 녹음이 있으면 그대로 남아 있어요.";
    showToast(error.message || "녹음 파일을 읽지 못했어요.");
  } finally {
    window.clearInterval(state.timerId);
    cancelAnimationFrame(state.visualId);
    state.mediaStream?.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
    state.mediaRecorder = null;
    if (state.audioContext) {
      await state.audioContext.close().catch(() => {});
      state.audioContext = null;
    }
    state.analyser = null;
    state.chunks = [];
    setPhase("idle");
    drawAnalysisVisualizer();
  }
}

async function acceptRecording(blob) {
  const context = new AudioContext();
  let buffer;
  try {
    buffer = await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await context.close().catch(() => {});
  }
  if (buffer.duration < 0.3) throw new Error("녹음이 너무 짧아요. 1초 이상 녹음해 주세요.");
  if (buffer.duration > 61) throw new Error("1분 이하의 녹음 파일을 골라 주세요.");
  const events = analyzeBabble(buffer);
  resetSong();
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  state.recordingBuffer = buffer;
  state.recordingBlob = blob;
  state.events = events;
  state.sourceUrl = URL.createObjectURL(blob);
  dom.sourcePlayer.src = state.sourceUrl;
  dom.sourceDownload.href = state.sourceUrl;
  const extension = blob.type.includes("mp4") || blob.type.includes("m4a") ? "m4a" : blob.type.includes("webm") ? "webm" : blob.type.includes("mpeg") ? "mp3" : blob.type.includes("ogg") ? "ogg" : "wav";
  dom.sourceDownload.download = `babble-original-${dateStamp()}.${extension}`;
  dom.sourceSection.hidden = false;
  dom.timer.textContent = formatTime(buffer.duration);
  dom.eventCount.textContent = events.length ? `${events.length}개 소리 조각` : "소리 감지 안 됨";
  dom.recordHint.textContent = events.length ? "오늘의 옹알이가 담겼어요." : "소리가 너무 작거나 일정해요. 조금 더 가까이에서 다시 녹음해 주세요.";
  drawAnalysisVisualizer();
}

async function makeSong() {
  if (isBusy() || !state.recordingBuffer || !state.events.length) return;
  setPhase("rendering");

  await new Promise((resolve) => window.setTimeout(resolve, 80));

  try {
    const styleKey = document.querySelector("input[name='style']:checked").value;
    const includeVoice = dom.includeVoice.checked;
    const wav = renderSong(state.recordingBuffer, state.events, styles[styleKey], includeVoice);
    state.songBlob = new Blob([wav], { type: "audio/wav" });
    state.savedAt = new Date().toISOString();
    state.styleKey = styleKey;
    displaySong();
    await persistSession();
    if (persistSession.succeeded) showToast("음악이 만들어졌어요.");
  } catch {
    showToast("음악을 만들지 못했어요. 다시 시도해 주세요.");
  } finally {
    setPhase("idle");
  }
}

function displaySong() {
  if (state.songUrl) URL.revokeObjectURL(state.songUrl);
  state.songUrl = URL.createObjectURL(state.songBlob);
  dom.player.src = state.songUrl;
  dom.downloadLink.href = state.songUrl;
  dom.downloadLink.classList.remove("disabled");
  dom.downloadLink.removeAttribute("aria-disabled");
  dom.downloadLink.removeAttribute("tabindex");
  dom.downloadLink.download = `babble-song-${dateStamp(state.savedAt)}-${state.styleKey}.wav`;
  dom.shareButton.disabled = false;
  dom.songState.textContent = `${styles[state.styleKey].label} 완성`;
  dom.songDate.textContent = new Date(state.savedAt).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  dom.resultSection.hidden = false;
}

async function shareSong() {
  if (!state.songBlob) return;

  const file = new File([state.songBlob], dom.downloadLink.download, { type: "audio/wav" });
  try {
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      title: "오늘의 옹알송",
      text: "아기 옹알이로 만든 작은 노래",
      files: [file],
    });
  } else {
    showToast("이 Safari에서는 저장 버튼으로 파일을 받을 수 있어요.");
  }
  } catch (error) {
    if (error.name !== "AbortError") showToast("공유하지 못했어요. 노래 저장을 눌러 주세요.");
  }
}

function analyzeBabble(buffer) {
  const samples = monoSamples(buffer);
  const rate = buffer.sampleRate;
  const windowSize = 2048;
  const hopSize = 1024;
  const frames = [];

  for (let cursor = 0; cursor + windowSize < samples.length; cursor += hopSize) {
    let sum = 0;
    for (let index = 0; index < windowSize; index += 1) {
      const sample = samples[cursor + index];
      sum += sample * sample;
    }
    frames.push({ time: cursor / rate, rms: Math.sqrt(sum / windowSize) });
  }

  if (!frames.length) return [];

  const sorted = frames.map((frame) => frame.rms).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length / 5)] || 0;
  const threshold = Math.max(0.006, noiseFloor * 2.4);
  const rough = [];
  let active = null;

  for (const frame of frames) {
    if (frame.rms >= threshold) {
      if (!active) {
        active = { start: frame.time, end: frame.time + windowSize / rate, energy: frame.rms };
      } else {
        active.end = frame.time + windowSize / rate;
        active.energy = Math.max(active.energy, frame.rms);
      }
    } else if (active) {
      rough.push(active);
      active = null;
    }
  }

  if (active) rough.push(active);

  const merged = [];
  for (const event of rough) {
    const previous = merged[merged.length - 1];
    if (previous && event.start - previous.end < 0.18) {
      previous.end = event.end;
      previous.energy = Math.max(previous.energy, event.energy);
    } else {
      merged.push({ ...event });
    }
  }

  return merged
    .map((event) => ({
      start: event.start,
      duration: event.end - event.start,
      energy: Math.min(1, event.energy / Math.max(threshold * 4, 0.001)),
      pitch: estimatePitch(samples, rate, event.start, Math.min(event.end - event.start, 0.45)),
    }))
    .filter((event) => event.duration >= 0.07)
    .slice(0, 32);
}

function renderSong(buffer, events, style, includeVoice) {
  const duration = Math.min(30, Math.max(14, buffer.duration + 4));
  const mix = new Float32Array(Math.floor(duration * sampleRate));
  // Fit every detected phrase into the song, including phrases late in a long recording.
  const beat = 60 / style.tempo;
  const lastStart = Math.max(1, ...events.map((event) => event.start));
  const timeScale = Math.min(1, (duration - 3) / lastStart);
  const arrangedEvents = events.map((event) => ({ ...event, songStart: 1 + quantize(event.start * timeScale, beat / 2) }));

  addHarmony(mix, style, duration);
  addMelody(mix, arrangedEvents, style);

  if (style.label === "로파이") {
    addLofiBeat(mix, style, duration);
  }

  if (includeVoice) {
    addVoice(mix, buffer, arrangedEvents);
  }

  normalize(mix);
  const fadeLength = Math.floor(sampleRate * 0.5);
  for (let index = 0; index < fadeLength; index += 1) {
    mix[index] *= index / fadeLength;
    mix[mix.length - 1 - index] *= index / fadeLength;
  }
  return encodeWav(mix, sampleRate);
}

function addHarmony(mix, style, duration) {
  const chords = [
    [60, 64, 67, 71],
    [57, 60, 64, 67],
    [53, 57, 60, 64],
    [55, 59, 62, 67],
  ];
  const beat = 60 / style.tempo;
  const chordLength = beat * 4;

  for (let time = 0, index = 0; time < duration; time += chordLength, index += 1) {
    for (const note of chords[index % chords.length]) {
      addTone(mix, note + (style.label === "로파이" ? -12 : 0), time, chordLength * 0.94, style.chordGain, style);
    }
  }
}

function addMelody(mix, events, style) {
  const beat = 60 / style.tempo;
  const sourceEvents = events;

  sourceEvents.forEach((event, index) => {
    let note;
    if (event.pitch) {
      let midi = Math.round(69 + 12 * Math.log2(event.pitch / 440));
      while (midi > 76) midi -= 12;
      while (midi < 60) midi += 12;
      const nearest = scale.reduce((best, current) => (
        Math.abs(60 + current - midi) < Math.abs(60 + best - midi) ? current : best
      ), 0);
      note = 60 + nearest;
    } else {
      note = 60 + scale[index % scale.length];
    }

    addTone(
      mix,
      note + style.noteOffset,
      event.songStart,
      Math.min(Math.max(event.duration, 0.16), beat * 1.5),
      style.melodyGain + event.energy * 0.09,
      style,
    );
  });
}

function addVoice(mix, buffer, events) {
  const samples = resampledMono(buffer, sampleRate);
  const sourceRate = sampleRate;

  events.forEach((event) => {
    const sourceStart = Math.floor(event.start * sourceRate);
    const sourceLength = Math.min(Math.floor(Math.min(event.duration, 0.7) * sourceRate), samples.length - sourceStart);
    const targetStart = Math.floor(event.songStart * sampleRate);

    for (let offset = 0; offset < sourceLength; offset += 1) {
      const targetIndex = targetStart + offset;
      if (targetIndex >= mix.length) break;
      const progress = offset / Math.max(1, sourceLength - 1);
      const fade = Math.min(1, progress * 8, (1 - progress) * 8);
      mix[targetIndex] += samples[sourceStart + offset] * 0.34 * fade;
    }
  });
}

function addLofiBeat(mix, style, duration) {
  const beat = 60 / style.tempo;
  for (let time = 0; time < duration; time += beat * 4) {
    addNoise(mix, time, 0.08, 0.16, true);
    addNoise(mix, time + beat * 2, 0.12, 0.11, false);
    for (let step = 0; step < 8; step += 1) {
      addNoise(mix, time + (step * beat) / 2, 0.025, 0.034, false);
    }
  }
}

function addTone(mix, midiNote, start, duration, gain, style) {
  const frequency = 440 * 2 ** ((midiNote - 69) / 12);
  const startIndex = Math.max(0, Math.floor(start * sampleRate));
  const frameCount = Math.max(1, Math.floor(duration * sampleRate));

  for (let frame = 0; frame < frameCount; frame += 1) {
    const index = startIndex + frame;
    if (index >= mix.length) break;

    const t = frame / sampleRate;
    const progress = frame / frameCount;
    const env = envelope(progress, style);
    const sine = Math.sin(2 * Math.PI * frequency * t);
    const overtone = Math.sin(2 * Math.PI * frequency * 2 * t) * (style.label === "오르골" ? 0.42 : 0.18);
    const soft = style.label === "로파이" ? Math.sin(2 * Math.PI * frequency * 0.5 * t) * 0.08 : 0;
    mix[index] += (sine + overtone + soft) * env * gain;
  }
}

function addNoise(mix, start, duration, gain, lowPass) {
  const startIndex = Math.max(0, Math.floor(start * sampleRate));
  const frameCount = Math.max(1, Math.floor(duration * sampleRate));
  let seed = startIndex + frameCount + 11;
  let previous = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const index = startIndex + frame;
    if (index >= mix.length) break;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    let sample = ((seed / 4294967295) * 2) - 1;
    if (lowPass) {
      sample = previous * 0.88 + sample * 0.12;
      previous = sample;
    }
    mix[index] += sample * gain * (1 - frame / frameCount);
  }
}

function envelope(progress, style) {
  const attack = style.label === "오르골" ? 0.02 : 0.08;
  const release = style.label === "오르골" ? 0.85 : 0.72;
  if (progress < attack) return progress / attack;
  return Math.max(0, 1 - ((progress - attack) / Math.max(0.001, release))) ** (style.label === "오르골" ? 1.8 : 1.2);
}

function estimatePitch(samples, rate, start, duration) {
  const startIndex = Math.max(0, Math.floor(start * rate));
  const count = Math.min(samples.length - startIndex, 4096, Math.max(512, Math.floor(duration * rate)));
  if (count <= 512) return null;

  const minLag = Math.max(1, Math.floor(rate / 1000));
  const maxLag = Math.min(Math.floor(count / 2), Math.floor(rate / 90));
  let bestLag = 0;
  let bestScore = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    let energy = 0;
    for (let index = 0; index < count - lag; index += 1) {
      const sample = samples[startIndex + index];
      score += sample * samples[startIndex + index + lag];
      energy += sample * sample;
    }
    const normalized = score / Math.max(energy, 0.000001);
    if (normalized > bestScore) {
      bestScore = normalized;
      bestLag = lag;
    }
  }

  return bestLag > 0 && bestScore > 0.2 ? rate / bestLag : null;
}

function monoSamples(buffer) {
  const output = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) {
      output[index] += data[index] / buffer.numberOfChannels;
    }
  }
  return output;
}

function resampledMono(buffer, targetRate) {
  const source = monoSamples(buffer);
  const ratio = buffer.sampleRate / targetRate;
  const output = new Float32Array(Math.floor(buffer.duration * targetRate));

  for (let index = 0; index < output.length; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(source.length - 1, left + 1);
    const mix = sourceIndex - left;
    output[index] = source[left] * (1 - mix) + source[right] * mix;
  }

  return output;
}

function normalize(samples) {
  let peak = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
  }
  if (peak <= 0.001) return;

  const gain = Math.min(1, 0.92 / peak);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] *= gain;
  }
}

function encodeWav(samples, rate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  writeText(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeText(view, 8, "WAVE");
  writeText(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeText(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

function writeText(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function quantize(value, grid) {
  return Math.round(value / grid) * grid;
}

function updateTimer() {
  const seconds = (performance.now() - state.recordingStartedAt) / 1000;
  dom.timer.textContent = formatTime(Math.min(maxSeconds, seconds));
  if (seconds >= maxSeconds) stopRecording();
}

function formatTime(seconds) {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function dateStamp(value = new Date()) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function openDatabase() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open("babble-tunes", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sessions");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

async function readSession() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("sessions").objectStore("sessions").get("latest");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function persistSession() {
  const snapshot = state.recordingBlob ? {
    recordingBlob: state.recordingBlob, songBlob: state.songBlob,
    savedAt: state.savedAt, styleKey: state.styleKey, includeVoice: dom.includeVoice.checked,
  } : null;
  saveQueue = saveQueue.then(async () => {
    const db = await openDatabase();
    // Store bytes rather than Blob objects for Safari's IndexedDB compatibility.
    const stored = snapshot ? {
      recordingData: await snapshot.recordingBlob.arrayBuffer(),
      recordingType: snapshot.recordingBlob.type,
      songData: snapshot.songBlob ? await snapshot.songBlob.arrayBuffer() : null,
      savedAt: snapshot.savedAt, styleKey: snapshot.styleKey, includeVoice: snapshot.includeVoice,
    } : null;
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("sessions", "readwrite");
      const store = transaction.objectStore("sessions");
      if (stored) store.put(stored, "latest");
      else store.delete("latest");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    persistSession.succeeded = true;
  }).catch(() => {
    persistSession.succeeded = false;
    showToast("기기에 보관하지 못했어요. 원본과 노래를 저장해 주세요.");
  });
  return saveQueue;
}

function resetSong() {
  if (state.songUrl) {
    URL.revokeObjectURL(state.songUrl);
  }
  state.songBlob = null;
  state.songUrl = null;
  state.events = [];
  state.recordingBuffer = null;
  dom.player.removeAttribute("src");
  dom.player.load();
  dom.downloadLink.href = "#";
  dom.downloadLink.classList.add("disabled");
  dom.downloadLink.setAttribute("aria-disabled", "true");
  dom.downloadLink.setAttribute("tabindex", "-1");
  dom.resultSection.hidden = true;
  dom.shareButton.disabled = true;
  dom.makeButton.disabled = true;
  dom.eventCount.textContent = "아직 분석 전";
  dom.songState.textContent = "대기 중";
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    dom.toast.classList.remove("visible");
  }, 3200);
}

function drawIdleVisualizer() {
  cancelAnimationFrame(state.visualId);
  const canvas = dom.canvas;
  const ctx = canvas.getContext("2d");
  drawWave(ctx, canvas, null);
}

function drawLiveVisualizer() {
  cancelAnimationFrame(state.visualId);
  const canvas = dom.canvas;
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(state.analyser.frequencyBinCount);

  const render = () => {
    state.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    state.level = Math.min(1, Math.sqrt(sum / data.length) * 3.5);
    drawWave(ctx, canvas, data);
    state.visualId = requestAnimationFrame(render);
  };
  render();
}

function drawAnalysisVisualizer() {
  cancelAnimationFrame(state.visualId);
  const canvas = dom.canvas;
  const ctx = canvas.getContext("2d");
  if (!state.recordingBuffer) { drawIdleVisualizer(); return; }
  const samples = monoSamples(state.recordingBuffer);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#137b73";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  for (let bar = 0; bar < 80; bar += 1) {
    const start = Math.floor(bar * samples.length / 80);
    const end = Math.floor((bar + 1) * samples.length / 80);
    let peak = 0;
    for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
    const height = Math.max(3, Math.min(68, peak * 130));
    ctx.beginPath();
    ctx.moveTo(bar * 8 + 4, 80 - height);
    ctx.lineTo(bar * 8 + 4, 80 + height);
    ctx.stroke();
  }
}

function drawWave(ctx, canvas, data) {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = data ? "#b74457" : "#93b6b4";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  for (let bar = 0; bar < 80; bar += 1) {
    const amplitude = data ? Math.abs(data[Math.floor(bar * data.length / 80)] - 128) / 128 : 0;
    const size = Math.max(3, amplitude * height * 0.45);
    ctx.beginPath();
    ctx.moveTo(bar * width / 80 + 4, height / 2 - size);
    ctx.lineTo(bar * width / 80 + 4, height / 2 + size);
    ctx.stroke();
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => {});
}
