import { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
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
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);
    sceneRef.current = scene;

    // Lighting — 3-point
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xfff5e6, 1.2);
    key.position.set(2, 3, 2);
    key.castShadow = true;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xe6f0ff, 0.5);
    fill.position.set(-2, 2, 1);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.3);
    rim.position.set(0, 2, -3);
    scene.add(rim);

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

        // Discover morph target meshes
        const meshes: THREE.Mesh[] = [];
        gltf.scene.traverse((child) => {
          if (
            child instanceof THREE.Mesh &&
            child.morphTargetInfluences &&
            child.morphTargetDictionary
          ) {
            meshes.push(child);
          }
        });
        morphMeshesRef.current = meshes;

        // Find head bone (Ready Player Me / standard humanoid rigs name it 'Head')
        gltf.scene.traverse((child) => {
          if (!headBoneRef.current && /^head$/i.test(child.name)) {
            headBoneRef.current = child;
          }
        });

        // Count unique morph target names
        const names = new Set<string>();
        for (const mesh of meshes) {
          if (mesh.morphTargetDictionary) {
            for (const name of Object.keys(mesh.morphTargetDictionary)) {
              names.add(name);
            }
          }
        }
        setMorphCount(names.size);

        // Animations
        if (gltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(gltf.scene);
          const action = mixer.clipAction(gltf.animations[0]);
          action.play();
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
