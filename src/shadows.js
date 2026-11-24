import * as THREE from 'three';
import { shared, createDepthMaterial } from './materials.js';

const SIZE = 2048;
const BASE_EXT = [40, 160, 640]; // cascade half-extents in metres at scale 1
const PERIOD = [1, 2, 4]; // far cascades change slowly on screen, so they are redrawn less often

// Three cascaded orthographic depth maps centred on the camera, texel-snapped in world space.
export class Shadows {
  constructor() {
    this.targets = BASE_EXT.map(() => {
      const depth = new THREE.DepthTexture(SIZE, SIZE);
      depth.minFilter = THREE.NearestFilter;
      depth.magFilter = THREE.NearestFilter;
      return new THREE.WebGLRenderTarget(SIZE, SIZE, {
        depthTexture: depth,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        generateMipmaps: false,
      });
    });
    shared.uSh0.value = this.targets[0].depthTexture;
    shared.uSh1.value = this.targets[1].depthTexture;
    shared.uSh2.value = this.targets[2].depthTexture;
    shared.uShSize.value = SIZE;
    this.material = createDepthMaterial();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.cam.matrixAutoUpdate = false;
    this.cam.matrixWorldAutoUpdate = false;
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.enabled = true;
    this.frame = 0;
    this.shift = new THREE.Matrix4();
    this.state = BASE_EXT.map(() => ({
      M: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
      sun: new THREE.Vector3(),
      ext: 0,
      range: 0,
      valid: false,
    }));
  }

  // Half-extent of the outermost cascade for a given scale.
  extent(scale) {
    return BASE_EXT[2] * scale;
  }

  render(renderer, scene, camPos, sun, scale, strength) {
    shared.uShadowOn.value = strength;
    if (strength <= 0 || !this.enabled) {
      shared.uShadowOn.value = 0;
      for (const s of this.state) s.valid = false;
      return;
    }
    const { right, up, cam, tmp } = this;
    const ref = Math.abs(sun.y) < 0.95 ? tmp.set(0, 1, 0) : tmp.set(1, 0, 0);
    right.crossVectors(ref, sun).normalize();
    up.crossVectors(sun, right).normalize();
    const cr = camPos.dot(right);
    const cu = camPos.dot(up);

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = scene.overrideMaterial;
    scene.overrideMaterial = this.material;
    this.frame++;
    for (let i = 0; i < 3; i++) {
      const ext = BASE_EXT[i] * scale;
      const st = this.state[i];
      const stale =
        st.valid && st.ext === ext && st.sun.dot(sun) > 0.99995 && this.frame % PERIOD[i] !== i % PERIOD[i];
      if (stale) {
        // The map stays fixed in world space; re-express its camera-relative matrix for the new camera position.
        shared.uShM.value[i].copy(st.M).multiply(this.shift.makeTranslation(tmp.copy(camPos).sub(st.pos)));
        shared.uShExt.value.setComponent(i, ext);
        shared.uShRange.value.setComponent(i, st.range);
        continue;
      }
      const z = Math.max(1500, ext * 2.5);
      const texel = (2 * ext) / SIZE;
      const offR = cr - Math.floor(cr / texel) * texel;
      const offU = cu - Math.floor(cu / texel) * texel;
      cam.left = -ext;
      cam.right = ext;
      cam.top = ext;
      cam.bottom = -ext;
      cam.near = 0;
      cam.far = 2 * z;
      cam.updateProjectionMatrix();
      cam.matrixWorld.makeBasis(right, up, sun);
      tmp.copy(right).multiplyScalar(-offR).addScaledVector(up, -offU).addScaledVector(sun, z);
      cam.matrixWorld.setPosition(tmp);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

      shared.uShM.value[i].multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      shared.uShExt.value.setComponent(i, ext);
      shared.uShRange.value.setComponent(i, 2 * z);
      st.M.copy(shared.uShM.value[i]);
      st.pos.copy(camPos);
      st.sun.copy(sun);
      st.ext = ext;
      st.range = 2 * z;
      st.valid = true;

      renderer.setRenderTarget(this.targets[i]);
      renderer.render(scene, cam);
    }
    scene.overrideMaterial = prevAuto;
    renderer.setRenderTarget(prevTarget);
  }
}
