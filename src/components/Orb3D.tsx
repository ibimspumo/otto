import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { AgentState } from "../lib/types";

// Zustandsfarben: Bernstein = sprechen, Eis = zuhören, Violett = denken.
const COLORS: Record<AgentState, THREE.Color> = {
  disconnected: new THREE.Color("#565c66"),
  connecting: new THREE.Color("#7a828c"),
  idle: new THREE.Color("#c49e64"),
  listening: new THREE.Color("#8fc6dc"),
  thinking: new THREE.Color("#b6a3ee"),
  speaking: new THREE.Color("#f2a950"),
};

// Ashima 3D-Simplex-Noise (Public Domain).
const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`;

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uAmp;
varying float vNoise;
varying vec3 vNormal;
varying vec3 vViewPos;
${NOISE_GLSL}
void main() {
  float n = snoise(position * 1.7 + vec3(uTime * 0.35));
  float n2 = snoise(position * 4.2 - vec3(uTime * 0.55)) * 0.35;
  float disp = (n + n2) * uAmp;
  vec3 p = position + normal * disp;
  vNoise = n;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vNoise;
varying vec3 vNormal;
varying vec3 vViewPos;
void main() {
  vec3 viewDir = normalize(-vViewPos);
  float fresnel = pow(1.0 - max(dot(viewDir, normalize(vNormal)), 0.0), 2.2);
  float glow = 0.28 + fresnel * 1.15 + vNoise * 0.14;
  vec3 col = uColor * glow + vec3(1.0) * fresnel * 0.32;
  gl_FragColor = vec4(col, 0.94);
}
`;

function makeGlowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.75)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.2)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

interface Orb3DProps {
  state: AgentState;
  levels: React.MutableRefObject<{ inp: number; out: number }>;
  size?: number;
  /**
   * "full" = die große Bühne (Kern + Ringe + Partikel).
   * "core" = nur der Plasma-Kern mit Glow — der Arc Reactor in der Insel.
   */
  variant?: "full" | "core";
}

/**
 * Der Glutkern in 3D: eine Shader-verformte Plasma-Sphäre, deren Amplitude
 * am Audiopegel hängt — als "full" umkreist von Gyroskop-Ringen und einem
 * Partikelfeld, als "core" pur (für die Insel-Kapsel).
 */
export default function Orb3D({
  state,
  levels,
  size = 560,
  variant = "full",
}: Orb3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const mount = mountRef.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coreOnly = variant === "core";

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
    // Weit genug zurück, dass Glow und Ringe vollständig im Bild liegen
    // und nicht an der quadratischen Canvas-Kante abgeschnitten werden.
    // Der pure Kern darf das Bild fast füllen.
    camera.position.z = coreOnly ? 3.1 : 5.6;

    const uniforms = {
      uTime: { value: 0 },
      uAmp: { value: 0.08 },
      uColor: { value: COLORS.disconnected.clone() },
    };

    // Plasma-Kern
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 24),
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
      }),
    );
    scene.add(core);

    // Feines Drahtgitter als äußere Hülle (nur auf der großen Bühne)
    const shellMat = new THREE.MeshBasicMaterial({
      wireframe: true,
      transparent: true,
      opacity: 0.05,
      color: COLORS.disconnected.clone(),
    });
    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.45, 2), shellMat);
    if (!coreOnly) scene.add(shell);

    // Gyroskop-Ringe
    const ringMats: THREE.MeshBasicMaterial[] = [];
    const rings: THREE.Mesh[] = [];
    if (!coreOnly) {
      [1.75, 1.95, 2.18].forEach((radius, i) => {
        const mat = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0.28 - i * 0.07,
          color: COLORS.disconnected.clone(),
        });
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(radius, 0.0045 + i * 0.0015, 6, 160),
          mat,
        );
        ring.rotation.set(Math.PI / 2 - i * 0.5, i * 0.9, i * 0.4);
        ringMats.push(mat);
        rings.push(ring);
        scene.add(ring);
      });
    }

    // Partikelfeld auf einer Kugelschale
    const COUNT = coreOnly ? 0 : 420;
    const positions = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const r = 1.55 + Math.random() * 0.85;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const particleMat = new THREE.PointsMaterial({
      size: 0.018,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      color: COLORS.disconnected.clone(),
    });
    const particles = new THREE.Points(particleGeo, particleMat);
    if (!coreOnly) scene.add(particles);

    // Weicher Glow hinter allem
    const glowTex = makeGlowTexture();
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      color: COLORS.disconnected.clone(),
    });
    const glow = new THREE.Sprite(glowMat);
    // Beim puren Kern steht die Kamera nah — der Glow muss ins Bild passen.
    const glowBase = coreOnly ? 2.3 : 3.9;
    glow.scale.setScalar(glowBase + 0.1);
    glow.position.z = -0.5;
    scene.add(glow);

    let raf = 0;
    let t = 0;
    let level = 0;

    const frame = () => {
      t += reduced ? 0.003 : 0.016;
      const s = stateRef.current;
      const target = COLORS[s];

      uniforms.uColor.value.lerp(target, 0.06);
      shellMat.color.lerp(target, 0.06);
      particleMat.color.lerp(target, 0.06);
      glowMat.color.lerp(target, 0.06);
      ringMats.forEach((m) => m.color.lerp(target, 0.06));

      const raw =
        s === "listening" ? levels.current.inp * 2.6 : levels.current.out * 1.9;
      const targetLevel = Math.min(1, raw);
      level += (targetLevel - level) * (targetLevel > level ? 0.35 : 0.08);

      const breathe =
        s === "idle" || s === "disconnected" ? Math.sin(t * 1.4) * 0.02 : 0;
      uniforms.uTime.value = t;
      uniforms.uAmp.value = 0.07 + level * 0.42 + breathe;

      core.rotation.y = t * 0.12;
      shell.rotation.y = -t * 0.05;
      shell.rotation.x = t * 0.03;

      // Beim Denken drehen die Ringe deutlich schneller und gegenläufig.
      const ringSpeed = s === "thinking" ? 1.6 : s === "speaking" ? 0.5 : 0.18;
      rings.forEach((ring, i) => {
        const dir = i % 2 === 0 ? 1 : -1;
        ring.rotation.z += 0.01 * ringSpeed * dir;
        ring.rotation.x += 0.004 * ringSpeed;
      });

      particles.rotation.y = t * 0.04;
      particleMat.opacity = 0.22 + level * 0.5;
      particleMat.size = 0.016 + level * 0.02;

      glowMat.opacity = 0.35 + level * 0.45;
      glow.scale.setScalar(glowBase + level * (coreOnly ? 0.35 : 0.7));

      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
      glowTex.dispose();
      particleGeo.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
          obj.geometry.dispose();
          const m = obj.material as THREE.Material | THREE.Material[];
          (Array.isArray(m) ? m : [m]).forEach((mm) => mm.dispose());
        }
      });
      mount.removeChild(renderer.domElement);
    };
  }, [levels, size, variant]);

  return <div ref={mountRef} className={`orb3d ${variant}`} />;
}
