import { DirectionalLight, Mesh, OrthographicCamera, ShadowMaterial, Vector3, VSMShadowMap, type BufferGeometry, type Side } from 'three';
import type { TryOnRenderer } from './try-on-renderer';

/** Half-size of the shadow camera around the glasses (cm): frame + temples. */
const EXTENT = 13;

/**
 * Soft shadows of the frame on the wearer's face (under the rims, on the nose below the bridge,
 * next to the hinges) — a strong cue that the glasses sit ON the face rather than floating over it.
 *
 * A dedicated shadow light (zero intensity: it adds no light, only the shadow) casts a small,
 * tight, blurred (VSM) shadow map from the glasses only (lenses excluded); the live face surface
 * from the occluder receives it with a ShadowMaterial, which darkens the camera image and is
 * otherwise invisible. Its direction is mostly frontal and slightly from above — typical indoor
 * light is broad and in front of a person looking at a screen — so shadows hug the rims instead
 * of being thrown far down the cheeks. The light follows the glasses so the map stays tight.
 */
export class ContactShadows {
  readonly receiver: Mesh<BufferGeometry, ShadowMaterial>;
  /** Darkness of a full shadow on skin (0..1). */
  strength = 0.38;
  readonly light = new DirectionalLight(0xffffff, 0);
  private on = true;
  private readonly dir = new Vector3(-0.15, 0.42, 0.9).normalize();

  constructor(
    private readonly view: TryOnRenderer,
    faceGeometry: BufferGeometry,
    faceSide: Side,
  ) {
    const r = view.renderer;
    r.shadowMap.enabled = true;
    r.shadowMap.type = VSMShadowMap;
    const light = this.light;
    light.castShadow = true;
    light.shadow.mapSize.set(512, 512);
    const cam = light.shadow.camera as OrthographicCamera;
    cam.left = -EXTENT;
    cam.right = EXTENT;
    cam.top = EXTENT;
    cam.bottom = -EXTENT;
    cam.near = 1;
    cam.far = 120;
    cam.updateProjectionMatrix();
    // ≈0.05 cm/texel; the VSM blur gives a ≈0.5 cm penumbra, like a soft room light.
    light.shadow.radius = 9;
    light.shadow.blurSamples = 16;
    light.shadow.bias = -0.0005;
    view.scene.add(light);
    view.scene.add(light.target);

    this.receiver = new Mesh(faceGeometry, new ShadowMaterial({ opacity: this.strength, depthWrite: false, side: faceSide }));
    this.receiver.receiveShadow = true;
    this.receiver.frustumCulled = false;
    this.receiver.renderOrder = -9;
    this.receiver.visible = false;
    view.scene.add(this.receiver);
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Toggling recompiles the glasses shaders once (shadow-map count changes). */
  set enabled(on: boolean) {
    this.on = on;
    this.light.castShadow = on;
    this.view.renderer.shadowMap.enabled = on;
    if (!on) this.receiver.visible = false;
  }

  /** @param anchor camera-space point at the glasses (nose rest), cm. */
  update(anchor: Vector3, visible: boolean): void {
    this.receiver.visible = this.on && visible;
    if (!this.receiver.visible) return;
    this.receiver.material.opacity = this.strength;
    const light = this.light;
    light.target.position.copy(anchor);
    light.position.copy(anchor).addScaledVector(this.dir, 60);
    light.target.updateMatrixWorld();
  }

  dispose(): void {
    this.receiver.removeFromParent();
    this.receiver.material.dispose();
    this.light.target.removeFromParent();
    this.light.removeFromParent();
    this.light.shadow.dispose();
  }
}
