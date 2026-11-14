import React, { useEffect, useRef } from 'react';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function Waveform3DCanvas({
  peaks,
  stereoWaveform,
  durationSec,
  playbackId,
  playbackStartedAt,
  accent = '#34d399'
}) {
  const canvasRef = useRef(null);
  const dataRef = useRef(null);
  const rotationRef = useRef(0.38);
  const dragRef = useRef(null);

  dataRef.current = {
    peaks,
    stereoWaveform,
    durationSec,
    playbackId,
    playbackStartedAt,
    accent
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return undefined;

    let frameId = 0;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, bounds.width);
      const nextHeight = Math.max(1, bounds.height);
      pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      if (
        nextWidth === width &&
        nextHeight === height &&
        canvas.width === Math.round(nextWidth * pixelRatio)
      ) {
        return;
      }
      width = nextWidth;
      height = nextHeight;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const draw = (now) => {
      resize();
      const data = dataRef.current;
      if (!data) return;

      context.clearRect(0, 0, width, height);
      const backdrop = context.createLinearGradient(0, 0, width, height);
      backdrop.addColorStop(0, '#111d20');
      backdrop.addColorStop(0.55, '#091214');
      backdrop.addColorStop(1, '#101719');
      context.fillStyle = backdrop;
      context.fillRect(0, 0, width, height);

      const plotLeft = width * 0.075;
      const plotWidth = width * 0.79;
      const midline = height * 0.52;
      const amplitudeScale = height * 0.27;
      const depth = height * 0.2;
      const depthX = depth * Math.sin(rotationRef.current);
      const depthY = depth * Math.cos(rotationRef.current);
      const project = (time, amplitude, z) => ({
        x: plotLeft + time * plotWidth + z * depthX,
        y: midline - amplitude * amplitudeScale - z * depthY
      });

      const floor = [
        project(0, -0.94, 0),
        project(1, -0.94, 0),
        project(1, -0.94, 1),
        project(0, -0.94, 1)
      ];
      context.beginPath();
      context.moveTo(floor[0].x, floor[0].y);
      floor.slice(1).forEach((point) => context.lineTo(point.x, point.y));
      context.closePath();
      const floorFill = context.createLinearGradient(0, midline, 0, height);
      floorFill.addColorStop(0, '#19c9c322');
      floorFill.addColorStop(1, '#19c9c303');
      context.fillStyle = floorFill;
      context.fill();

      context.lineWidth = 1;
      context.strokeStyle = '#65e7d51a';
      for (let division = 0; division <= 10; division += 1) {
        const time = division / 10;
        const front = project(time, -0.94, 0);
        const back = project(time, -0.94, 1);
        context.beginPath();
        context.moveTo(front.x, front.y);
        context.lineTo(back.x, back.y);
        context.stroke();
      }
      for (let division = 0; division <= 5; division += 1) {
        const z = division / 5;
        const left = project(0, -0.94, z);
        const right = project(1, -0.94, z);
        context.beginPath();
        context.moveTo(left.x, left.y);
        context.lineTo(right.x, right.y);
        context.stroke();
      }
      for (const amplitude of [-0.5, 0, 0.5]) {
        for (const z of [0, 1]) {
          const left = project(0, amplitude, z);
          const right = project(1, amplitude, z);
          context.beginPath();
          context.moveTo(left.x, left.y);
          context.lineTo(right.x, right.y);
          context.strokeStyle = amplitude === 0 ? '#b9fff52b' : '#65e7d510';
          context.stroke();
        }
      }

      const length = Math.max(1, data.peaks?.length || 0);
      const leftMin = data.stereoWaveform?.leftMin;
      const leftMax = data.stereoWaveform?.leftMax;
      const rightMin = data.stereoWaveform?.rightMin;
      const rightMax = data.stereoWaveform?.rightMax;
      const channelData = (index, channel) => {
        const minimum = channel === 0 ? leftMin?.[index] : rightMin?.[index];
        const maximum = channel === 0 ? leftMax?.[index] : rightMax?.[index];
        if (Number.isFinite(minimum) && Number.isFinite(maximum)) return [minimum, maximum];
        const estimate = data.peaks?.[index] || 0;
        return [-estimate * 0.25, estimate];
      };

      const bands = [
        { z: 0.18, color: '#47e6d0' },
        { z: 0.78, color: '#ffb454' }
      ];

      bands.forEach(({ z, color }, channel) => {
        const upper = [];
        const lower = [];
        for (let index = 0; index < length; index += 1) {
          const [low, high] = channelData(index, channel);
          const time = length === 1 ? 0 : index / (length - 1);
          upper.push(project(time, clamp(high, -1, 1), z));
          lower.push(project(time, clamp(low, -1, 1), z));
        }

        context.beginPath();
        upper.forEach((point, index) => {
          if (index === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        });
        for (let index = lower.length - 1; index >= 0; index -= 1) {
          context.lineTo(lower[index].x, lower[index].y);
        }
        context.closePath();
        context.fillStyle = `${color}20`;
        context.fill();

        context.beginPath();
        upper.forEach((point, index) => {
          if (index === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        });
        context.strokeStyle = color;
        context.lineWidth = 1.4;
        context.shadowBlur = 11;
        context.shadowColor = color;
        context.stroke();
        context.shadowBlur = 0;
      });

      if (leftMin && rightMin) {
        context.beginPath();
        const stride = Math.max(1, Math.floor(length / 110));
        for (let index = 0; index < length; index += stride) {
          const [leftLow, leftHigh] = channelData(index, 0);
          const [rightLow, rightHigh] = channelData(index, 1);
          const time = length === 1 ? 0 : index / (length - 1);
          const left = project(time, (leftLow + leftHigh) / 2, 0.18);
          const right = project(time, (rightLow + rightHigh) / 2, 0.78);
          context.moveTo(left.x, left.y);
          context.lineTo(right.x, right.y);
        }
        context.strokeStyle = '#f3fff523';
        context.lineWidth = 0.7;
        context.stroke();
      }

      const elapsedSec =
        data.playbackId && data.playbackStartedAt
          ? Math.max(0, (now - data.playbackStartedAt) / 1000)
          : -1;
      const playbackFraction =
        data.durationSec > 0 && elapsedSec >= 0
          ? elapsedSec / data.durationSec
          : -1;
      const scanFraction =
        playbackFraction >= 0 && playbackFraction <= 1
          ? playbackFraction
          : ((now / 7500) % 1);
      const scan = project(scanFraction, 0.98, 0.48);
      const scanBottom = project(scanFraction, -0.94, 0.48);
      context.beginPath();
      context.moveTo(scan.x, scan.y);
      context.lineTo(scanBottom.x, scanBottom.y);
      context.strokeStyle = playbackFraction >= 0 && playbackFraction <= 1
        ? '#edfff0'
        : '#67efd466';
      context.lineWidth = playbackFraction >= 0 && playbackFraction <= 1 ? 1.6 : 1;
      context.shadowBlur = 12;
      context.shadowColor = data.accent;
      context.stroke();
      context.shadowBlur = 0;

      context.font = '8px ui-monospace, Menlo, monospace';
      context.fillStyle = '#81a9a2';
      context.fillText('L', project(0, 0, 0.18).x - 3, project(0, 0, 0.18).y - 5);
      context.fillStyle = '#d5a25e';
      context.fillText('R', project(0, 0, 0.78).x - 3, project(0, 0, 0.78).y - 5);
      context.fillStyle = '#607773';
      context.fillText('0', plotLeft - 7, height - 5);
      context.fillText(data.durationSec ? `${data.durationSec.toFixed(2)}s` : '--', plotLeft + plotWidth - 27, height - 5);

      frameId = window.requestAnimationFrame(draw);
    };

    frameId = window.requestAnimationFrame(draw);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(resize);
    observer?.observe(canvas);
    return () => {
      window.cancelAnimationFrame(frameId);
      observer?.disconnect();
    };
  }, []);

  const handlePointerDown = (event) => {
    dragRef.current = { x: event.clientX, rotation: rotationRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event) => {
    if (!dragRef.current) return;
    const width = event.currentTarget.getBoundingClientRect().width || 1;
    rotationRef.current = clamp(
      dragRef.current.rotation + ((event.clientX - dragRef.current.x) / width) * 2.4,
      -1.1,
      1.1
    );
  };

  const handlePointerUp = (event) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className="waveform-3d-canvas"
      role="img"
      aria-label="Interactive three-dimensional stereo waveform of the rendered layer sum. Drag horizontally to rotate."
      title="Drag horizontally to rotate the stereo waveform field"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}
