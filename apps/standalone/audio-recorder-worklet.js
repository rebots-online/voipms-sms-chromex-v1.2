class VoxVolleyPcmCapture extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input?.length) {
      const copy = new Float32Array(input);
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
    for (const channel of outputs[0] || []) channel.fill(0);
    return true;
  }
}

registerProcessor("voxvolley-pcm-capture", VoxVolleyPcmCapture);
