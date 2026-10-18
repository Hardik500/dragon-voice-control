interface Window {
  dragonMic: {
    onStart(cb: (generation: number, options?: { deviceId?: string }) => void): void;
    onStop(cb: (generation: number) => void): void;
    sendChunk(buf: Uint8Array, generation: number): void;
    sendStatus(status: string, detail: string | undefined, generation: number): void;
  };
}

(function micCaptureRenderer() {
const TARGET_SAMPLE_RATE = 16000;

interface CaptureRequest {
  generation: number;
  epoch: number;
}

interface CaptureGraph {
  stream: MediaStream;
  context: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  processor: ScriptProcessorNode | null;
  gain: GainNode | null;
  onTrackEnded: () => void;
  disposed: boolean;
}

let generation = 0;
let inputDeviceId = "";
let epoch = 0;
let captureWanted = false;
let starting = false;
let errorLatched = false;
let activeGraph: CaptureGraph | null = null;
let pendingGraph: CaptureGraph | null = null;

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

function isCurrent(request: CaptureRequest): boolean {
  return captureWanted && request.generation === generation && request.epoch === epoch;
}

function releaseGraph(graph: CaptureGraph | null): void {
  if (!graph || graph.disposed) return;
  graph.disposed = true;
  if (graph.processor) graph.processor.onaudioprocess = null;
  if (graph.context) graph.context.onstatechange = null;
  for (const track of graph.stream.getTracks()) {
    track.removeEventListener("ended", graph.onTrackEnded);
    try { track.stop(); } catch { /* Continue releasing the other resources. */ }
  }
  for (const node of [graph.processor, graph.source, graph.gain]) {
    try { node?.disconnect(); } catch { /* Already disconnected. */ }
  }
  if (graph.context && graph.context.state !== "closed") {
    void graph.context.close().catch(() => {});
  }
}

function releaseCaptureGraphs(): void {
  const active = activeGraph;
  const pending = pendingGraph;
  activeGraph = null;
  pendingGraph = null;
  releaseGraph(active);
  releaseGraph(pending);
}

function failCapture(request: CaptureRequest, detail: string, graph: CaptureGraph | null): void {
  if (!isCurrent(request)) {
    releaseGraph(graph);
    return;
  }
  captureWanted = false;
  errorLatched = true;
  epoch++;
  releaseCaptureGraphs();
  releaseGraph(graph);
  window.dragonMic.sendStatus("error", detail, request.generation);
}

function describeCaptureError(error: unknown): string {
  const name = error instanceof Error ? error.name
    : typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "Microphone access was denied. Allow microphone access for Dragon in system privacy settings, then retry.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone was found. Connect or enable a microphone, then retry.";
    case "NotReadableError":
    case "TrackStartError":
      return "The microphone could not be opened. Close other apps using it, check your input device, then retry.";
    case "OverconstrainedError":
      return "The selected microphone is unavailable or cannot use these audio settings. Choose System default or another input in Settings, then retry.";
    case "AbortError":
      return "Microphone startup was interrupted. Check your input device, then retry.";
    default:
      return "Microphone capture could not start. Check system microphone permissions and your input device, then retry.";
  }
}

// Only this loop acquires devices. A new start waits for a pending request to settle,
// releases its stale stream, then acquires for the latest generation.
async function acquireCapture(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    while (captureWanted && !activeGraph) {
      const request = { generation, epoch };
      let graph: CaptureGraph | null = null;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}) },
          video: false,
        });
        graph = {
          stream,
          context: null,
          source: null,
          processor: null,
          gain: null,
          onTrackEnded: () => {},
          disposed: false,
        };
        if (!isCurrent(request)) {
          releaseGraph(graph);
          continue;
        }

        pendingGraph = graph;
        const captureGraph = graph;
        captureGraph.onTrackEnded = () => failCapture(request,
          "The microphone disconnected or stopped. Reconnect or enable it, then retry.", captureGraph);
        for (const track of stream.getAudioTracks()) {
          track.addEventListener("ended", captureGraph.onTrackEnded);
        }
        if (!stream.getAudioTracks().some((track) => track.readyState === "live")) {
          failCapture(request, "No active microphone was found. Connect or enable a microphone, then retry.", graph);
          continue;
        }

        const context = new AudioContext();
        graph.context = context;
        graph.source = context.createMediaStreamSource(stream);
        graph.processor = context.createScriptProcessor(4096, 1, 1);
        graph.gain = context.createGain();
        graph.gain.gain.value = 0; // Never play the mic back out to speakers.

        graph.processor.onaudioprocess = (event) => {
          if (!isCurrent(request) || activeGraph !== captureGraph || context.state !== "running") return;
          const input = event.inputBuffer.getChannelData(0);
          const pcm16 = downsampleTo16kInt16(input, context.sampleRate);
          window.dragonMic.sendChunk(new Uint8Array(pcm16.buffer), request.generation);
        };
        graph.source.connect(graph.processor);
        graph.processor.connect(graph.gain);
        graph.gain.connect(context.destination);

        if (context.state === "suspended") await context.resume();
        if (!isCurrent(request)) {
          releaseGraph(graph);
          continue;
        }
        if (context.state !== "running") {
          failCapture(request, "Microphone audio could not start. Check your input device and retry.", graph);
          continue;
        }

        activeGraph = graph;
        pendingGraph = null;
        context.onstatechange = () => {
          if (activeGraph === captureGraph && context.state !== "running") {
            failCapture(request, "Microphone audio was interrupted. Check your input device, then retry.", captureGraph);
          }
        };
        window.dragonMic.sendStatus("capturing", undefined, request.generation);
      } catch (error: unknown) {
        failCapture(request, describeCaptureError(error), graph);
      } finally {
        if (pendingGraph === graph) pendingGraph = null;
        if (activeGraph !== graph) releaseGraph(graph);
      }
    }
  } finally {
    starting = false;
  }
}

function startCapture(nextGeneration: number, options?: { deviceId?: string }): void {
  if (!Number.isSafeInteger(nextGeneration) || nextGeneration < generation) return;
  if (captureWanted && nextGeneration === generation) return;
  generation = nextGeneration;
  inputDeviceId = options?.deviceId ?? "";
  epoch++;
  captureWanted = true;
  errorLatched = false;
  releaseCaptureGraphs();
  window.dragonMic.sendStatus("starting", undefined, generation);
  void acquireCapture();
}

function stopCapture(nextGeneration: number): void {
  if (!Number.isSafeInteger(nextGeneration) || nextGeneration < generation) return;
  generation = nextGeneration;
  epoch++;
  captureWanted = false;
  releaseCaptureGraphs();
  // Main may stop capture as part of handling the error. Keep its useful detail
  // visible until the user explicitly starts a new capture.
  if (!errorLatched) window.dragonMic.sendStatus("stopped", undefined, generation);
}

window.addEventListener("DOMContentLoaded", () => {
  window.dragonMic.onStart(startCapture);
  window.dragonMic.onStop(stopCapture);
  window.dragonMic.sendStatus("ready", undefined, 0);
});
})();
