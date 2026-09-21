interface Window {
  dragonMic: {
    onStart(cb: () => void): void;
    onStop(cb: () => void): void;
    sendChunk(buf: Uint8Array): void;
    sendStatus(status: string, detail?: string): void;
  };
}

(function micCaptureRenderer() {
const TARGET_SAMPLE_RATE = 16000;

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processorNode: ScriptProcessorNode | null = null;
let silentGain: GainNode | null = null;

function downsampleTo16kInt16(input: Float32Array, inputSampleRate: number): Int16Array {
  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = floatToInt16(input[i]);
    return out;
  }
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIndex - i0;
    const sample = input[i0] * (1 - frac) + input[i1] * frac;
    out[i] = floatToInt16(sample);
  }
  return out;
}

function floatToInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

async function startCapture() {
  if (audioContext) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    audioContext = new AudioContext();
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0; // Never play the mic back out to speakers.

    processorNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const pcm16 = downsampleTo16kInt16(input, audioContext!.sampleRate);
      window.dragonMic.sendChunk(new Uint8Array(pcm16.buffer));
    };

    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    window.dragonMic.sendStatus("capturing");
  } catch (err: any) {
    window.dragonMic.sendStatus("error", err?.message ?? String(err));
    stopCapture();
  }
}

function stopCapture() {
  processorNode?.disconnect();
  sourceNode?.disconnect();
  silentGain?.disconnect();
  mediaStream?.getTracks().forEach((t) => t.stop());
  audioContext?.close();
  audioContext = null;
  mediaStream = null;
  sourceNode = null;
  processorNode = null;
  silentGain = null;
  window.dragonMic.sendStatus("stopped");
}

window.addEventListener("DOMContentLoaded", () => {
  window.dragonMic.onStart(() => startCapture());
  window.dragonMic.onStop(() => stopCapture());
});
})();
