import { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Agent, Message } from '../types';
import type { StateVector } from '../emotion';
import { useEmotionStream } from '../hooks/useEmotionStream';
import { EmotionDriver, IdleAnimator } from '../emotion';
import type { MocapPts } from '../emotion';

interface Visage3DPanelProps {
  agent: Agent;
  messages: Message[];
  modelUrl?: string;
  onFallback?: () => void;
  /** Fill the parent container instead of using a fixed square aspect ratio */
  fillContainer?: boolean;
}

/**
 * Map emotion-driven MocapPts to ARKit-style morph target names.
 * These are the standard blend shapes found in Ready Player Me and
 * similar avatar GLBs. The mapping is approximate — a real avatar
 * will have a subset of these.
 */
function mocapToMorphTargets(pts: MocapPts): Record<string, number> {
  const targets: Record<string, number> = {};

  // Eye open/close → eyeBlink (inverse)
  const leftBlink = 1.0 - Math.max(0, Math.min(1, pts.left_eye_open));
  const rightBlink = 1.0 - Math.max(0, Math.min(1, pts.right_eye_open));
  targets['eyeBlinkLeft'] = leftBlink;
  targets['eyeBlinkRight'] = rightBlink;

  // Brow
  const leftBrowUp = Math.max(0, pts.left_brow_height * 3);
  const rightBrowUp = Math.max(0, pts.right_brow_height * 3);
  const leftBrowDown = Math.max(0, -pts.left_brow_height * 3);
  const rightBrowDown = Math.max(0, -pts.right_brow_height * 3);
  targets['browInnerUp'] = (leftBrowUp + rightBrowUp) / 2;
  targets['browOuterUpLeft'] = leftBrowUp;
  targets['browOuterUpRight'] = rightBrowUp;
  targets['browDownLeft'] = leftBrowDown;
  targets['browDownRight'] = rightBrowDown;

  // Mouth
  const smile = Math.max(0, pts.mouth_smile * 2);
  const frown = Math.max(0, -pts.mouth_smile * 2);
  targets['mouthSmileLeft'] = smile;
  targets['mouthSmileRight'] = smile;
  targets['mouthFrownLeft'] = frown;
  targets['mouthFrownRight'] = frown;

  // Mouth open / jaw
  targets['mouthOpen'] = Math.max(0, Math.min(1, pts.mouth_open));
  targets['jawOpen'] = Math.max(0, Math.min(1, pts.jaw_open));

  // Mouth wide
  targets['mouthStretchLeft'] = Math.max(0, Math.min(1, pts.mouth_wide * 0.5));
  targets['mouthStretchRight'] = Math.max(0, Math.min(1, pts.mouth_wide * 0.5));

  // Pupil (if model supports it)
  targets['eyeLookOutLeft'] = Math.max(0, -pts.left_pupil_x);
  targets['eyeLookInLeft'] = Math.max(0, pts.left_pupil_x);
  targets['eyeLookUpLeft'] = Math.max(0, -pts.left_pupil_y);
  targets['eyeLookDownLeft'] = Math.max(0, pts.left_pupil_y);
  targets['eyeLookOutRight'] = Math.max(0, pts.right_pupil_x);
  targets['eyeLookInRight'] = Math.max(0, -pts.right_pupil_x);
  targets['eyeLookUpRight'] = Math.max(0, -pts.right_pupil_y);
  targets['eyeLookDownRight'] = Math.max(0, pts.right_pupil_y);

  // Clamp everything [0,1]
  for (const key of Object.keys(targets)) {
    targets[key] = Math.max(0, Math.min(1, targets[key]));
  }

  return targets;
}

// ── Mesh classification (ported from personas/src/viewer/avatar-controller.mjs) ──

function classifyMesh(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('rig_helper') || n.includes('weight_paint_helper')) return 'hidden';
  if (n.includes('eye_highlight')) return 'eye_highlight';
  if (n.includes('eyel001_1') || n.includes('eyer001_1')) return 'iris';
  if (n.includes('eyel') || n.includes('eyer')) return 'eye';
  if (n.includes('eyelash') || n.includes('eyelid')) return 'lash';
  if (n.includes('eyebrow')) return 'hair';
  if (n.includes('hair') || n.includes('hairgroom')) return 'hair';
  if (n.includes('scrunchy')) return 'fabric';
  if (n.includes('teeth')) return 'teeth';
  if (n.includes('tongue')) return 'tongue';
  if (n.includes('jacket_button') || n.includes('jacket_pin')) return 'metal';
  if (n.includes('jacket')) return 'jacket';
  if (n.includes('trousers')) return 'fabric';
  if (n.includes('boots')) return 'leather';
  if (n.includes('watch')) return 'metal';
  if (n.includes('earring')) return 'metal';
  if (n.includes('fannypack_main')) return 'fabric';
  if (n.includes('fannypack')) return 'metal';
  if (n.includes('handkerchief')) return 'fabric';
  if (n.includes('body')) return 'skin';
  if (n.includes('head')) return 'skin';
  if (n.includes('face_line')) return 'skin';
  return 'skin';
}

// ── Procedural texture helpers ──

function proceduralTexture(size: number, drawFn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  drawFn(ctx, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSkinMap(): THREE.CanvasTexture {
  return proceduralTexture(512, (ctx, w, h) => {
    ctx.fillStyle = '#8a7878';
    ctx.fillRect(0, 0, w, h);
    for (let s = 64; s >= 4; s = Math.floor(s / 2)) {
      ctx.globalAlpha = 0.08;
      for (let y = 0; y < h; y += s) {
        for (let x = 0; x < w; x += s) {
          const r = 110 + Math.floor(Math.random() * 30);
          const g = 105 + Math.floor(Math.random() * 25);
          const b = 115 + Math.floor(Math.random() * 35);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x, y, s, s);
        }
      }
    }
    ctx.globalAlpha = 0.05;
    for (let i = 0; i < 600; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = 0.5 + Math.random() * 1.5;
      ctx.fillStyle = 'rgba(60,70,90,0.4)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.04;
    ctx.strokeStyle = '#40c0d0';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 15; i++) {
      let px = Math.random() * w;
      let py = Math.random() * h;
      ctx.beginPath();
      ctx.moveTo(px, py);
      for (let j = 0; j < 5; j++) {
        if (Math.random() > 0.5) px += 10 + Math.random() * 30;
        else py += 10 + Math.random() * 30;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  });
}

function createCircuitMap(): THREE.CanvasTexture {
  return proceduralTexture(512, (ctx, w, h) => {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;
    for (let i = 0; i < 25; i++) {
      let px = Math.random() * w;
      let py = Math.random() * h;
      ctx.beginPath();
      ctx.moveTo(px, py);
      for (let j = 0; j < 4 + Math.floor(Math.random() * 4); j++) {
        if (Math.random() > 0.5) px += (Math.random() > 0.5 ? 1 : -1) * (15 + Math.random() * 40);
        else py += (Math.random() > 0.5 ? 1 : -1) * (15 + Math.random() * 40);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      ctx.beginPath();
      ctx.arc(x, y, 1.5 + Math.random() * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function createFabricMap(): THREE.CanvasTexture {
  return proceduralTexture(256, (ctx, w, h) => {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = '#606060';
    ctx.lineWidth = 1;
    for (let y = 0; y < h; y += 3) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y + (Math.random() - 0.5) * 2);
      ctx.stroke();
    }
    for (let x = 0; x < w; x += 3) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + (Math.random() - 0.5) * 2, h);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.1;
    for (let s = 32; s >= 4; s = Math.floor(s / 2)) {
      for (let y = 0; y < h; y += s) {
        for (let x = 0; x < w; x += s) {
          const v = 100 + Math.floor(Math.random() * 56);
          ctx.fillStyle = `rgb(${v},${v},${v})`;
          ctx.fillRect(x, y, s, s);
        }
      }
    }
  });
}

function createLeatherMap(): THREE.CanvasTexture {
  return proceduralTexture(256, (ctx, w, h) => {
    ctx.fillStyle = '#787070';
    ctx.fillRect(0, 0, w, h);
    for (let s = 32; s >= 2; s = Math.floor(s / 2)) {
      ctx.globalAlpha = 0.12;
      for (let y = 0; y < h; y += s) {
        for (let x = 0; x < w; x += s) {
          const v = 90 + Math.floor(Math.random() * 50);
          ctx.fillStyle = `rgb(${v},${v},${v})`;
          ctx.fillRect(x, y, s, s);
        }
      }
    }
    ctx.globalAlpha = 0.2;
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const len = 10 + Math.random() * 40;
      ctx.strokeStyle = 'rgba(50,45,40,0.5)';
      ctx.lineWidth = 0.5 + Math.random() * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * len, y + Math.random() * len * 0.3);
      ctx.stroke();
    }
  });
}

function createGrimeMap(): THREE.CanvasTexture {
  return proceduralTexture(256, (ctx, w, h) => {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, w, h);
    for (let s = 64; s >= 2; s = Math.floor(s / 2)) {
      ctx.globalAlpha = 0.15;
      for (let y = 0; y < h; y += s) {
        for (let x = 0; x < w; x += s) {
          const v = Math.floor(Math.random() * 80 + 88);
          ctx.fillStyle = `rgb(${v},${v},${v})`;
          ctx.fillRect(x, y, s, s);
        }
      }
    }
    ctx.globalAlpha = 0.2;
    for (let i = 0; i < 15; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = 3 + Math.random() * 10;
      ctx.fillStyle = 'rgba(30,30,30,0.3)';
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.4, Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

// ── Per-category material creation (cached) ──

const materialCache: Record<string, THREE.MeshStandardMaterial> = {};

function getMaterial(category: string): THREE.MeshStandardMaterial {
  if (materialCache[category]) return materialCache[category];
  const mat = createMaterial(category);
  materialCache[category] = mat;
  return mat;
}

function createMaterial(category: string): THREE.MeshStandardMaterial {
  switch (category) {
    case 'skin':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.55, 0.42, 0.38),
        roughness: 0.95,
        metalness: 0.0,
        roughnessMap: createSkinMap(),
        emissive: new THREE.Color(0.0, 0.03, 0.06),
        emissiveIntensity: 0.15,
      });
    case 'eye':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.08, 0.08, 0.1),
        roughness: 0.3,
        metalness: 0.0,
        emissive: new THREE.Color(0.15, 0.15, 0.2),
        emissiveIntensity: 0.4,
      });
    case 'iris':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.0, 0.15, 0.2),
        roughness: 0.2,
        metalness: 0.0,
        emissive: new THREE.Color(0.0, 0.8, 1.0),
        emissiveIntensity: 0.6,
      });
    case 'eye_highlight':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(1.0, 1.0, 1.0),
        emissive: new THREE.Color(0.5, 0.9, 1.0),
        emissiveIntensity: 1.2,
        transparent: true,
        opacity: 0.9,
        roughness: 0.0,
        metalness: 0.0,
      });
    case 'lash':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.02, 0.02, 0.03),
        roughness: 1.0,
        metalness: 0.0,
      });
    case 'hair':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.05, 0.03, 0.08),
        roughness: 0.85,
        metalness: 0.0,
        emissive: new THREE.Color(0.15, 0.0, 0.3),
        emissiveIntensity: 0.2,
      });
    case 'teeth':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.85, 0.85, 0.9),
        roughness: 0.5,
        metalness: 0.0,
        emissive: new THREE.Color(0.05, 0.05, 0.1),
        emissiveIntensity: 0.1,
      });
    case 'tongue':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.5, 0.2, 0.25),
        roughness: 0.9,
        metalness: 0.0,
        emissive: new THREE.Color(0.08, 0.01, 0.02),
        emissiveIntensity: 0.1,
      });
    case 'jacket':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.06, 0.06, 0.1),
        roughness: 0.92,
        metalness: 0.0,
        roughnessMap: createFabricMap(),
        emissiveMap: createCircuitMap(),
        emissive: new THREE.Color(0.0, 0.6, 0.8),
        emissiveIntensity: 0.25,
      });
    case 'fabric':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.08, 0.06, 0.12),
        roughness: 0.92,
        metalness: 0.0,
        roughnessMap: createFabricMap(),
        emissive: new THREE.Color(0.2, 0.0, 0.4),
        emissiveIntensity: 0.12,
      });
    case 'leather':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.06, 0.05, 0.08),
        roughness: 0.8,
        metalness: 0.0,
        roughnessMap: createLeatherMap(),
        emissive: new THREE.Color(0.0, 0.15, 0.2),
        emissiveIntensity: 0.15,
      });
    case 'metal':
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.3, 0.32, 0.35),
        roughness: 0.45,
        metalness: 0.7,
        roughnessMap: createGrimeMap(),
        emissive: new THREE.Color(0.0, 0.5, 0.6),
        emissiveIntensity: 0.15,
      });
    default:
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.1, 0.1, 0.15),
        roughness: 0.9,
        metalness: 0.0,
        emissive: new THREE.Color(0.0, 0.1, 0.15),
        emissiveIntensity: 0.1,
      });
  }
}

/**
 * Visage3DPanel — Three.js GLB avatar renderer with emotion-driven morph targets.
 * Drop-in replacement for the 2D VisagePanel canvas renderer.
 */
export function Visage3DPanel({ agent, messages, modelUrl, onFallback, fillContainer }: Visage3DPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const morphMeshesRef = useRef<THREE.Mesh[]>([]);
  const headBoneRef = useRef<THREE.Object3D | null>(null);
  const clockRef = useRef(new THREE.Clock());
  const rafRef = useRef<number>(0);
  const driverRef = useRef(new EmotionDriver(200, 2000));
  const idleRef = useRef(new IdleAnimator(Math.random() * 10000 | 0));
  const lastFrameRef = useRef(Date.now());
  const disposedRef = useRef(false);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadProgress, setLoadProgress] = useState(0);
  const [morphCount, setMorphCount] = useState(0);

  const emotionState = useEmotionStream(messages, agent.id);

  // Update driver when emotion state changes
  useEffect(() => {
    if (emotionState) {
      driverRef.current.update(emotionState);
    }
  }, [emotionState]);

  // Init Three.js scene
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    disposedRef.current = false;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05050f);
    sceneRef.current = scene;

    // PBR environment map — required for metallic/reflective materials
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment()).texture;
    pmremGenerator.dispose();

    // Camera
    const rect = container.getBoundingClientRect();
    const aspect = rect.width / (rect.height || 1);
    const fov = fillContainer ? 30 : 25;
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
    // Pull back for wide viewports, close-up for square panels
    if (fillContainer) {
      camera.position.set(0, 1.45, 2.2);
    } else {
      camera.position.set(0, 1.55, 1.2);
    }
    cameraRef.current = camera;

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, fillContainer ? 1.35 : 1.45, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.5;
    controls.maxDistance = 5;
    controls.update();
    controlsRef.current = controls;

    // Resize
    const onResize = () => {
      const r = container.getBoundingClientRect();
      const w = r.width;
      const h = r.height || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);
    onResize();

    const url = modelUrl || '/models/ellie_animation.glb';
    const loader = new GLTFLoader();

    loader.load(
      url,
      (gltf) => {
        if (disposedRef.current) return;
        scene.add(gltf.scene);

        // Classify meshes: hide non-skinned, apply per-category materials
        const morphMeshes: THREE.Mesh[] = [];
        gltf.scene.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;

          // Hide non-skinned (static) meshes — skull, helpers, etc.
          if (!(child as any).isSkinnedMesh) {
            child.visible = false;
            return;
          }

          // Classify and assign procedural material
          const category = classifyMesh(child.name);
          if (category === 'hidden') {
            child.visible = false;
          } else {
            child.material = getMaterial(category);
          }

          // Track meshes with morph targets for animation
          if (child.morphTargetInfluences && child.morphTargetDictionary) {
            morphMeshes.push(child);
          }
        });
        morphMeshesRef.current = morphMeshes;

        // Find head bone
        gltf.scene.traverse((child) => {
          if (!headBoneRef.current && /^head$/i.test(child.name)) {
            headBoneRef.current = child;
          }
        });

        // Count unique morph target names
        const names = new Set<string>();
        for (const mesh of morphMeshes) {
          if (mesh.morphTargetDictionary) {
            for (const name of Object.keys(mesh.morphTargetDictionary)) {
              names.add(name);
            }
          }
        }
        setMorphCount(names.size);

        // Animations — play idle, strip bone tracks from face clips
        if (gltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(gltf.scene);

          // Find and play idle animation
          const idleClip = gltf.animations.find(c => c.name === 'ANI-ellie.idle');
          if (idleClip) {
            const action = mixer.clipAction(idleClip);
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.play();
          } else {
            // Fallback: play first animation
            const action = mixer.clipAction(gltf.animations[0]);
            action.play();
          }

          mixerRef.current = mixer;
        }

        setStatus('ready');
        setLoadProgress(100);
      },
      (event) => {
        if (event.total > 0) {
          setLoadProgress(Math.round((event.loaded / event.total) * 100));
        }
      },
      (err) => {
        console.warn('Visage3DPanel: model load failed', err);
        setStatus('error');
        onFallback?.();
      },
    );

    // Render loop
    const animate = () => {
      if (disposedRef.current) return;
      rafRef.current = requestAnimationFrame(animate);

      const delta = clockRef.current.getDelta();
      const now = Date.now();
      const dt = Math.min((now - lastFrameRef.current) / 1000, 0.1);
      lastFrameRef.current = now;

      // Get current emotion frame
      const frame = driverRef.current.frame();
      idleRef.current.apply(frame.pts, dt);

      // Map to morph targets
      const targets = mocapToMorphTargets(frame.pts);

      // Apply to meshes
      for (const mesh of morphMeshesRef.current) {
        const dict = mesh.morphTargetDictionary;
        const influences = mesh.morphTargetInfluences;
        if (!dict || !influences) continue;
        for (const [name, value] of Object.entries(targets)) {
          const idx = dict[name];
          if (idx !== undefined) {
            influences[idx] = value;
          }
        }
      }

      // Head rotation via bone
      if (headBoneRef.current && frame.pts) {
        const pitch = Math.max(-0.4, Math.min(0.4, frame.pts.head_pitch ?? 0));
        const yaw   = Math.max(-0.5, Math.min(0.5, frame.pts.head_yaw   ?? 0));
        const roll  = Math.max(-0.3, Math.min(0.3, frame.pts.head_roll  ?? 0));
        headBoneRef.current.rotation.set(pitch, yaw, roll, 'YXZ');
      }

      mixerRef.current?.update(delta);
      controls.update();
      renderer.render(scene, camera);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      disposedRef.current = true;
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      controls.dispose();
      mixerRef.current?.stopAllAction();
      renderer.dispose();
      if (renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
      morphMeshesRef.current = [];
    };
  }, [modelUrl]);

  const emotionLabel = emotionState
    ? Object.entries(emotionState)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${v.toFixed(1)}`)
        .join(', ')
    : 'neutral';

  return (
    <div className="visage-panel" style={fillContainer ? { width: '100%', height: '100%' } : undefined}>
      <div
        ref={containerRef}
        className="visage-3d-container"
        style={{
          width: '100%',
          ...(fillContainer
            ? { height: '100%' }
            : { aspectRatio: '1' }),
          borderRadius: fillContainer ? 0 : '4px',
          overflow: 'hidden',
          background: '#111',
          position: 'relative',
        }}
      >
        {status === 'loading' && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            color: '#888',
            fontFamily: 'monospace',
            fontSize: '11px',
          }}>
            <span>loading model… {loadProgress > 0 ? `${loadProgress}%` : ''}</span>
            <div style={{
              width: '60%',
              maxWidth: 200,
              height: 4,
              background: '#333',
              borderRadius: 2,
              overflow: 'hidden',
            }}>
              <div style={{
                width: `${loadProgress}%`,
                height: '100%',
                background: 'var(--accent-blue, #5b9cf6)',
                borderRadius: 2,
                transition: 'width 0.2s ease',
              }} />
            </div>
          </div>
        )}
      </div>
      {!fillContainer && (
        <div className="visage-emotion-label" style={{
          fontSize: '11px',
          color: '#888',
          marginTop: '4px',
          fontFamily: 'monospace',
          textAlign: 'center',
        }}>
          {status === 'ready' && morphCount > 0
            ? `3D · ${morphCount} morphs · ${emotionLabel}`
            : status === 'ready'
            ? `3D · ${emotionLabel}`
            : status === 'error'
            ? '3D load failed'
            : 'loading...'}
        </div>
      )}
    </div>
  );
}
