import { useRef, useEffect } from 'react';
import type { Agent, Message } from '../types';
import { EmotionDriver, IdleAnimator } from '../emotion';
import { useEmotionStream } from '../hooks/useEmotionStream';
import type { MocapFrame, MocapPts } from '../emotion';

interface VisagePanelProps {
  agent: Agent;
  messages: Message[];
}

// --- Face renderer (ported from visage/web/public/renderer.js, polished) ---

const STYLE = {
  headColor: '#2a2a3a',
  headHighlight: '#353548',
  headOutline: '#444466',
  headOutlineWidth: 0.003,
  headRadiusX: 0.28,
  headRadiusY: 0.38,
  eyeWhiteColor: '#e8e8ee',
  irisColor: '#4488bb',
  irisRingColor: '#336699',
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
  browColor: '#444466',
  browWidth: 0.003,
  browLength: 0.08,
  browY: -0.14,
  mouthColor: '#cc4455',
  mouthInnerColor: '#441122',
  mouthTeethColor: '#dddddd',
  mouthOutline: '#993344',
  mouthY: 0.16,
  mouthBaseWidth: 0.08,
  noseColor: '#3a3a4a',
  noseShadow: '#252535',
  noseY: 0.04,
  bgColor: '#111111',
};

function renderFace(ctx: CanvasRenderingContext2D, w: number, h: number, frame: MocapFrame) {
  const cx = w / 2;
  const cy = h / 2;
  const s = Math.min(w, h);
  const pts = frame.pts;
  const scale = pts.face_scale || 1.0;

  const fy = (frac: number) => cy + frac * s * scale;
  const fs = (frac: number) => frac * s * scale;

  // Clear
  ctx.fillStyle = STYLE.bgColor;
  ctx.fillRect(0, 0, w, h);

  // Head transforms
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(pts.head_roll || 0);
  ctx.translate(-(pts.head_yaw || 0) * s * 0.15, (pts.head_pitch || 0) * s * 0.15);
  ctx.translate(-cx, -cy);

  // Head — with subtle gradient for dimension
  const headRx = fs(STYLE.headRadiusX);
  const headRy = fs(STYLE.headRadiusY);
  const headGrad = ctx.createRadialGradient(
    cx - headRx * 0.3, cy - headRy * 0.3, headRx * 0.1,
    cx, cy, headRy
  );
  headGrad.addColorStop(0, STYLE.headHighlight);
  headGrad.addColorStop(1, STYLE.headColor);

  ctx.beginPath();
  ctx.ellipse(cx, cy, headRx, headRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = headGrad;
  ctx.fill();
  ctx.strokeStyle = STYLE.headOutline;
  ctx.lineWidth = fs(STYLE.headOutlineWidth);
  ctx.stroke();

  // Nose — proper bridge and tip shape, follows head yaw
  const noseX = cx + (pts.head_yaw || 0) * fs(0.05);
  const noseTop = fy(STYLE.noseY - 0.02);
  const noseTip = fy(STYLE.noseY + 0.025);
  const noseW = fs(0.018);

  // Bridge line (subtle)
  ctx.beginPath();
  ctx.moveTo(noseX, noseTop);
  ctx.lineTo(noseX, fy(STYLE.noseY + 0.01));
  ctx.strokeStyle = STYLE.noseColor;
  ctx.lineWidth = fs(0.0015);
  ctx.lineCap = 'round';
  ctx.stroke();

  // Nostrils / tip
  ctx.beginPath();
  ctx.moveTo(noseX - noseW, noseTip);
  ctx.quadraticCurveTo(noseX - noseW * 0.5, noseTip + fs(0.008), noseX, noseTip + fs(0.003));
  ctx.quadraticCurveTo(noseX + noseW * 0.5, noseTip + fs(0.008), noseX + noseW, noseTip);
  ctx.strokeStyle = STYLE.noseColor;
  ctx.lineWidth = fs(0.002);
  ctx.lineCap = 'round';
  ctx.stroke();

  // Nose shadow
  ctx.beginPath();
  ctx.ellipse(noseX, noseTip + fs(0.002), noseW * 0.6, fs(0.003), 0, 0, Math.PI * 2);
  ctx.fillStyle = STYLE.noseShadow;
  ctx.globalAlpha = 0.3;
  ctx.fill();
  ctx.globalAlpha = 1.0;

  // Eyes
  const yawOffset = (pts.head_yaw || 0) * fs(0.03);

  const drawEye = (side: 'left' | 'right') => {
    const sign = side === 'left' ? -1 : 1;
    // Perspective shift: near eye spreads, far eye compresses with head yaw
    const perspScale = 1.0 + (pts.head_yaw || 0) * sign * 0.15;
    const ex = cx + sign * fs(STYLE.eyeSpacingX) * perspScale + yawOffset;
    const ey = fy(STYLE.eyeY);
    const openAmount = pts[`${side}_eye_open` as keyof MocapPts] as number ?? 0.85;
    const pupilDx = ((pts[`${side}_pupil_x` as keyof MocapPts] as number) || 0) * fs(0.02);
    const pupilDy = ((pts[`${side}_pupil_y` as keyof MocapPts] as number) || 0) * fs(0.02);

    ctx.save();
    const eyeH = fs(STYLE.eyeRadiusY) * Math.max(0.05, openAmount);
    const eyeRx = fs(STYLE.eyeRadiusX);

    // Clip to eye opening (almond shape)
    ctx.beginPath();
    ctx.ellipse(ex, ey, eyeRx, eyeH, 0, 0, Math.PI * 2);
    ctx.clip();

    // Eye white with subtle gradient
    const eyeGrad = ctx.createRadialGradient(ex, ey, 0, ex, ey, eyeRx);
    eyeGrad.addColorStop(0, STYLE.eyeWhiteColor);
    eyeGrad.addColorStop(1, '#ccccdd');
    ctx.beginPath();
    ctx.ellipse(ex, ey, eyeRx, fs(STYLE.eyeRadiusY), 0, 0, Math.PI * 2);
    ctx.fillStyle = eyeGrad;
    ctx.fill();

    // Iris — outer ring
    const irisR = fs(STYLE.irisRadius);
    ctx.beginPath();
    ctx.arc(ex + pupilDx, ey + pupilDy, irisR, 0, Math.PI * 2);
    ctx.fillStyle = STYLE.irisRingColor;
    ctx.fill();

    // Iris — inner gradient
    const irisGrad = ctx.createRadialGradient(
      ex + pupilDx, ey + pupilDy, irisR * 0.2,
      ex + pupilDx, ey + pupilDy, irisR
    );
    irisGrad.addColorStop(0, STYLE.irisColor);
    irisGrad.addColorStop(1, STYLE.irisRingColor);
    ctx.beginPath();
    ctx.arc(ex + pupilDx, ey + pupilDy, irisR * 0.9, 0, Math.PI * 2);
    ctx.fillStyle = irisGrad;
    ctx.fill();

    // Pupil
    ctx.beginPath();
    ctx.arc(ex + pupilDx, ey + pupilDy, fs(STYLE.pupilRadius) * perspScale, 0, Math.PI * 2);
    ctx.fillStyle = STYLE.pupilColor;
    ctx.fill();

    // Highlight — primary
    ctx.beginPath();
    ctx.arc(ex + pupilDx + fs(0.008), ey + pupilDy - fs(0.008), fs(STYLE.highlightRadius), 0, Math.PI * 2);
    ctx.fillStyle = STYLE.highlightColor;
    ctx.fill();

    // Highlight — secondary (smaller, opposite side)
    ctx.beginPath();
    ctx.arc(ex + pupilDx - fs(0.004), ey + pupilDy + fs(0.005), fs(STYLE.highlightRadius * 0.5), 0, Math.PI * 2);
    ctx.fillStyle = STYLE.highlightColor;
    ctx.globalAlpha = 0.4;
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Upper eyelid shadow
    ctx.beginPath();
    ctx.ellipse(ex, ey - eyeH * 0.3, eyeRx, eyeH * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20, 20, 40, 0.15)';
    ctx.fill();

    ctx.restore();

    // Eye outline
    ctx.beginPath();
    ctx.ellipse(ex, ey, eyeRx, eyeH, 0, 0, Math.PI * 2);
    ctx.strokeStyle = STYLE.eyeOutline;
    ctx.lineWidth = fs(0.002);
    ctx.stroke();

    // Eyelashes on upper lid
    if (openAmount > 0.2) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(ex, ey, eyeRx, eyeH, 0, Math.PI + 0.3, Math.PI * 2 - 0.3);
      ctx.strokeStyle = '#222244';
      ctx.lineWidth = fs(0.003);
      ctx.lineCap = 'round';
      ctx.stroke();

      // Individual lash strokes
      const lashCount = 5;
      for (let i = 0; i < lashCount; i++) {
        const t = (i + 0.5) / lashCount;
        const angle = Math.PI + 0.4 + t * (Math.PI - 0.8);
        const lx = ex + Math.cos(angle) * eyeRx;
        const ly = ey + Math.sin(angle) * eyeH;
        const outX = lx + Math.cos(angle - 0.2) * fs(0.008);
        const outY = ly + Math.sin(angle - 0.2) * fs(0.008);
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(outX, outY);
        ctx.strokeStyle = '#222244';
        ctx.lineWidth = fs(0.0015);
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  drawEye('left');
  drawEye('right');

  // Eyebrows — variable thickness with taper
  const drawBrow = (side: 'left' | 'right') => {
    const sign = side === 'left' ? -1 : 1;
    const browPerspScale = 1.0 + (pts.head_yaw || 0) * sign * 0.15;
    const bx = cx + sign * fs(STYLE.eyeSpacingX) * browPerspScale + yawOffset;
    const by = fy(STYLE.browY) - ((pts[`${side}_brow_height` as keyof MocapPts] as number) || 0.03) * s;
    const angle = ((pts[`${side}_brow_angle` as keyof MocapPts] as number) || 0) * sign;

    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(angle);

    const halfLen = fs(STYLE.browLength / 2);

    // Draw brow as a filled shape for variable thickness
    ctx.beginPath();
    ctx.moveTo(-halfLen, fs(0.001));
    ctx.quadraticCurveTo(-halfLen * 0.3, -fs(0.006), 0, -fs(0.005));
    ctx.quadraticCurveTo(halfLen * 0.5, -fs(0.004), halfLen, fs(0.001));
    ctx.quadraticCurveTo(halfLen * 0.5, fs(0.003), 0, fs(0.002));
    ctx.quadraticCurveTo(-halfLen * 0.3, fs(0.003), -halfLen, fs(0.001));
    ctx.closePath();
    ctx.fillStyle = STYLE.browColor;
    ctx.fill();

    ctx.restore();
  };

  drawBrow('left');
  drawBrow('right');

  // Mouth — cubic bezier for natural lip curves
  const mouthOpen = pts.mouth_open || 0;
  const mouthWide = pts.mouth_wide || 0;
  const mouthSmile = pts.mouth_smile || 0;
  const jawOpen = pts.jaw_open || 0;

  const mx = cx + yawOffset;
  const my = fy(STYLE.mouthY) + jawOpen * fs(0.03);
  const mw = fs(STYLE.mouthBaseWidth) + mouthWide * fs(0.04);
  const mh = mouthOpen * fs(0.04) + jawOpen * fs(0.02);
  const smileCurve = mouthSmile * fs(0.025);

  if (mouthOpen > 0.02 || jawOpen > 0.02) {
    // Open mouth — dark interior
    ctx.beginPath();
    ctx.moveTo(mx - mw, my);
    ctx.bezierCurveTo(mx - mw * 0.5, my - fs(0.01) - smileCurve, mx + mw * 0.5, my - fs(0.01) - smileCurve, mx + mw, my);
    ctx.bezierCurveTo(mx + mw * 0.5, my + mh + smileCurve * 0.5, mx - mw * 0.5, my + mh + smileCurve * 0.5, mx - mw, my);
    ctx.closePath();
    ctx.fillStyle = STYLE.mouthInnerColor;
    ctx.fill();

    // Teeth hint (when mouth is moderately open)
    if (mouthOpen > 0.1 || jawOpen > 0.1) {
      const teethH = Math.min(mh * 0.35, fs(0.012));
      ctx.beginPath();
      ctx.moveTo(mx - mw * 0.7, my + fs(0.002));
      ctx.bezierCurveTo(mx - mw * 0.3, my - fs(0.003), mx + mw * 0.3, my - fs(0.003), mx + mw * 0.7, my + fs(0.002));
      ctx.lineTo(mx + mw * 0.7, my + teethH);
      ctx.lineTo(mx - mw * 0.7, my + teethH);
      ctx.closePath();
      ctx.fillStyle = STYLE.mouthTeethColor;
      ctx.globalAlpha = 0.6;
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }

    // Upper lip
    ctx.beginPath();
    ctx.moveTo(mx - mw, my);
    ctx.bezierCurveTo(mx - mw * 0.5, my - fs(0.012) - smileCurve, mx + mw * 0.5, my - fs(0.012) - smileCurve, mx + mw, my);
    ctx.bezierCurveTo(mx + mw * 0.3, my + fs(0.005), mx - mw * 0.3, my + fs(0.005), mx - mw, my);
    ctx.closePath();
    ctx.fillStyle = STYLE.mouthColor;
    ctx.fill();

    // Outline
    ctx.beginPath();
    ctx.moveTo(mx - mw, my);
    ctx.bezierCurveTo(mx - mw * 0.5, my - fs(0.012) - smileCurve, mx + mw * 0.5, my - fs(0.012) - smileCurve, mx + mw, my);
    ctx.bezierCurveTo(mx + mw * 0.5, my + mh + smileCurve * 0.5, mx - mw * 0.5, my + mh + smileCurve * 0.5, mx - mw, my);
    ctx.strokeStyle = STYLE.mouthOutline;
    ctx.lineWidth = fs(0.0015);
    ctx.stroke();
  } else {
    // Closed mouth — curved line with lip shape
    // Upper lip cupid's bow
    ctx.beginPath();
    ctx.moveTo(mx - mw, my + smileCurve);
    ctx.bezierCurveTo(
      mx - mw * 0.3, my - smileCurve * 1.5,
      mx - fs(0.005), my - smileCurve * 1.5 - fs(0.003),
      mx, my - smileCurve * 1.2
    );
    ctx.bezierCurveTo(
      mx + fs(0.005), my - smileCurve * 1.5 - fs(0.003),
      mx + mw * 0.3, my - smileCurve * 1.5,
      mx + mw, my + smileCurve
    );
    ctx.strokeStyle = STYLE.mouthColor;
    ctx.lineWidth = fs(0.003);
    ctx.lineCap = 'round';
    ctx.stroke();

    // Lower lip hint
    ctx.beginPath();
    ctx.moveTo(mx - mw * 0.6, my + smileCurve + fs(0.003));
    ctx.quadraticCurveTo(mx, my + smileCurve + fs(0.012), mx + mw * 0.6, my + smileCurve + fs(0.003));
    ctx.strokeStyle = STYLE.mouthColor;
    ctx.lineWidth = fs(0.0015);
    ctx.globalAlpha = 0.4;
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  // Subtle cheek blush when smiling
  if (mouthSmile > 0.15) {
    const blushAlpha = Math.min(0.12, (mouthSmile - 0.15) * 0.3);
    const blushR = fs(0.035);
    for (const bside of [-1, 1]) {
      const bx = cx + bside * fs(STYLE.eyeSpacingX + 0.04) + yawOffset;
      const by = fy(0.08);
      const blushGrad = ctx.createRadialGradient(bx, by, 0, bx, by, blushR);
      blushGrad.addColorStop(0, `rgba(200,80,100,${blushAlpha})`);
      blushGrad.addColorStop(1, 'rgba(200,80,100,0)');
      ctx.beginPath();
      ctx.arc(bx, by, blushR, 0, Math.PI * 2);
      ctx.fillStyle = blushGrad;
      ctx.fill();
    }
  }

  ctx.restore();
}

// --- React Component ---

export function VisagePanel({ agent, messages }: VisagePanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const driverRef = useRef<EmotionDriver>(new EmotionDriver(200, 2000));
  const idleRef = useRef<IdleAnimator>(new IdleAnimator(Math.random() * 10000 | 0));
  const lastFrameRef = useRef<number>(Date.now());
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
        // Reset transform before scaling to prevent compound scaling on resize
        ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      const now = Date.now();
      const dt = Math.min((now - lastFrameRef.current) / 1000, 0.1); // seconds, capped
      lastFrameRef.current = now;

      const frame = driverRef.current.frame();
      // Apply idle animation (breathing, blinking, eye drift) on top
      idleRef.current.apply(frame.pts, dt);
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
