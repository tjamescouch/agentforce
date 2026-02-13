import { useRef, useEffect } from 'react';
import type { Agent, Message } from '../types';
import { EmotionDriver } from '../emotion';
import { useEmotionStream } from '../hooks/useEmotionStream';
import type { MocapFrame, MocapPts } from '../emotion';

interface VisagePanelProps {
  agent: Agent;
  messages: Message[];
}

// --- Minimal face renderer (ported from visage/web/public/renderer.js) ---

const STYLE = {
  headColor: '#2a2a3a',
  headOutline: '#444466',
  headOutlineWidth: 0.003,
  headRadiusX: 0.28,
  headRadiusY: 0.38,
  eyeWhiteColor: '#e8e8ee',
  irisColor: '#4488bb',
  pupilColor: '#111122',
  highlightColor: '#ffffff',
  eyeOutline: '#333355',
  eyeSpacingX: 0.12,
  eyeY: -0.06,
  eyeRadiusX: 0.055,
  eyeRadiusY: 0.04,
  irisRadius: 0.025,
  pupilRadius: 0.013,
  highlightRadius: 0.005,
  browColor: '#333355',
  browWidth: 0.002,
  browLength: 0.08,
  browY: -0.14,
  mouthColor: '#cc4455',
  mouthInnerColor: '#661122',
  mouthOutline: '#993344',
  mouthY: 0.16,
  mouthBaseWidth: 0.08,
  noseColor: '#3a3a4a',
  noseY: 0.04,
  bgColor: '#111111',
};

function renderFace(ctx: CanvasRenderingContext2D, w: number, h: number, frame: MocapFrame) {
  const cx = w / 2;
  const cy = h / 2;
  const s = Math.min(w, h);
  const pts = frame.pts;

  const fy = (frac: number) => cy + frac * s;
  const fs = (frac: number) => frac * s;

  // Clear
  ctx.fillStyle = STYLE.bgColor;
  ctx.fillRect(0, 0, w, h);

  // Head transforms
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(pts.head_roll || 0);
  ctx.translate(-(pts.head_yaw || 0) * s * 0.1, (pts.head_pitch || 0) * s * 0.1);
  ctx.translate(-cx, -cy);

  // Head
  ctx.beginPath();
  ctx.ellipse(cx, cy, fs(STYLE.headRadiusX), fs(STYLE.headRadiusY), 0, 0, Math.PI * 2);
  ctx.fillStyle = STYLE.headColor;
  ctx.fill();
  ctx.strokeStyle = STYLE.headOutline;
  ctx.lineWidth = fs(STYLE.headOutlineWidth);
  ctx.stroke();

  // Nose
  const noseX = cx;
  const noseY = fy(STYLE.noseY);
  ctx.beginPath();
  ctx.moveTo(noseX, noseY - fs(0.015));
  ctx.quadraticCurveTo(noseX + fs(0.01), noseY + fs(0.01), noseX, noseY + fs(0.015));
  ctx.strokeStyle = STYLE.noseColor;
  ctx.lineWidth = fs(0.002);
  ctx.stroke();

  // Eyes
  const drawEye = (side: 'left' | 'right') => {
    const sign = side === 'left' ? -1 : 1;
    const ex = cx + sign * fs(STYLE.eyeSpacingX);
    const ey = fy(STYLE.eyeY);
    const openAmount = pts[`${side}_eye_open` as keyof MocapPts] as number ?? 0.85;
    const pupilDx = ((pts[`${side}_pupil_x` as keyof MocapPts] as number) || 0) * fs(0.015);
    const pupilDy = ((pts[`${side}_pupil_y` as keyof MocapPts] as number) || 0) * fs(0.015);

    ctx.save();
    const eyeH = fs(STYLE.eyeRadiusY) * Math.max(0.05, openAmount);
    ctx.beginPath();
    ctx.ellipse(ex, ey, fs(STYLE.eyeRadiusX), eyeH, 0, 0, Math.PI * 2);
    ctx.clip();

    ctx.beginPath();
    ctx.ellipse(ex, ey, fs(STYLE.eyeRadiusX), fs(STYLE.eyeRadiusY), 0, 0, Math.PI * 2);
    ctx.fillStyle = STYLE.eyeWhiteColor;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(ex + pupilDx, ey + pupilDy, fs(STYLE.irisRadius), 0, Math.PI * 2);
    ctx.fillStyle = STYLE.irisColor;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(ex + pupilDx, ey + pupilDy, fs(STYLE.pupilRadius), 0, Math.PI * 2);
    ctx.fillStyle = STYLE.pupilColor;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(ex + pupilDx + fs(0.008), ey + pupilDy - fs(0.008), fs(STYLE.highlightRadius), 0, Math.PI * 2);
    ctx.fillStyle = STYLE.highlightColor;
    ctx.fill();

    ctx.restore();

    ctx.beginPath();
    ctx.ellipse(ex, ey, fs(STYLE.eyeRadiusX), eyeH, 0, 0, Math.PI * 2);
    ctx.strokeStyle = STYLE.eyeOutline;
    ctx.lineWidth = fs(0.002);
    ctx.stroke();
  };

  drawEye('left');
  drawEye('right');

  // Eyebrows
  const drawBrow = (side: 'left' | 'right') => {
    const sign = side === 'left' ? -1 : 1;
    const bx = cx + sign * fs(STYLE.eyeSpacingX);
    const by = fy(STYLE.browY) - ((pts[`${side}_brow_height` as keyof MocapPts] as number) || 0.03) * s;
    const angle = ((pts[`${side}_brow_angle` as keyof MocapPts] as number) || 0) * sign;

    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(angle);

    ctx.beginPath();
    ctx.moveTo(-fs(STYLE.browLength / 2), 0);
    ctx.quadraticCurveTo(0, -fs(0.008), fs(STYLE.browLength / 2), fs(0.003));
    ctx.strokeStyle = STYLE.browColor;
    ctx.lineWidth = fs(STYLE.browWidth);
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.restore();
  };

  drawBrow('left');
  drawBrow('right');

  // Mouth
  const mouthOpen = pts.mouth_open || 0;
  const mouthWide = pts.mouth_wide || 0;
  const mouthSmile = pts.mouth_smile || 0;
  const jawOpen = pts.jaw_open || 0;

  const mx = cx;
  const my = fy(STYLE.mouthY) + jawOpen * fs(0.03);
  const mw = fs(STYLE.mouthBaseWidth) + mouthWide * fs(0.04);
  const mh = mouthOpen * fs(0.04) + jawOpen * fs(0.02);
  const smileCurve = mouthSmile * fs(0.02);

  if (mouthOpen > 0.02 || jawOpen > 0.02) {
    ctx.beginPath();
    ctx.moveTo(mx - mw, my);
    ctx.quadraticCurveTo(mx, my - fs(0.01) - smileCurve, mx + mw, my);
    ctx.quadraticCurveTo(mx, my + mh + smileCurve, mx - mw, my);
    ctx.closePath();
    ctx.fillStyle = STYLE.mouthInnerColor;
    ctx.fill();
    ctx.strokeStyle = STYLE.mouthOutline;
    ctx.lineWidth = fs(0.002);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(mx - mw, my);
    ctx.quadraticCurveTo(mx, my - fs(0.01) - smileCurve, mx + mw, my);
    ctx.quadraticCurveTo(mx, my + fs(0.005), mx - mw, my);
    ctx.fillStyle = STYLE.mouthColor;
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(mx - mw, my + smileCurve);
    ctx.quadraticCurveTo(mx, my - smileCurve * 2, mx + mw, my + smileCurve);
    ctx.strokeStyle = STYLE.mouthColor;
    ctx.lineWidth = fs(0.003);
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  ctx.restore();
}

// --- React Component ---

export function VisagePanel({ agent, messages }: VisagePanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const driverRef = useRef<EmotionDriver>(new EmotionDriver(200, 2000));
  const rafRef = useRef<number>(0);

  // Parse latest emotion state from agent messages
  const emotionState = useEmotionStream(messages, agent.id);

  // Update driver when emotion state changes
  useEffect(() => {
    if (emotionState) {
      driverRef.current.update(emotionState);
    }
  }, [emotionState]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function tick() {
      const c = canvasRef.current;
      if (!c) return;

      // Handle DPR for sharp rendering
      const rect = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = rect.width;
      const h = rect.height;

      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width = w * dpr;
        c.height = h * dpr;
        ctx!.scale(dpr, dpr);
      }

      const frame = driverRef.current.frame();
      renderFace(ctx!, w, h, frame);

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Label for current emotion
  const emotionLabel = emotionState
    ? Object.entries(emotionState)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${v.toFixed(1)}`)
        .join(', ')
    : 'neutral';

  return (
    <div className="visage-panel">
      <canvas
        ref={canvasRef}
        className="visage-canvas"
        style={{ width: '100%', aspectRatio: '1', borderRadius: '4px' }}
      />
      <div className="visage-emotion-label" style={{
        fontSize: '11px',
        color: '#888',
        marginTop: '4px',
        fontFamily: 'monospace',
        textAlign: 'center',
      }}>
        {emotionLabel}
      </div>
    </div>
  );
}
