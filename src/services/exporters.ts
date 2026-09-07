import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { downloadBlob } from '@/lib/utils';

/**
 * Bakes the live scene (which uses instancing) into plain meshes so any
 * exporter / external viewer can consume the result.
 */
export function bakeWorldGroup(root: THREE.Object3D): THREE.Group {
  const baked = new THREE.Group();
  baked.name = 'atlas3d-world';
  root.updateWorldMatrix(true, true);

  root.traverseVisible((obj) => {
    if ((obj as THREE.Mesh).isMesh !== true) return;
    const mesh = obj as THREE.Mesh;
    if (!mesh.visible || !mesh.geometry) return;
    // Skip helpers (grid, gizmos) — they mark themselves with userData.helper.
    for (let parent: THREE.Object3D | null = mesh; parent; parent = parent.parent) {
      if (parent.userData.helper || !parent.visible) return;
    }
    const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cloneMaterials = (instanceColors = false) => {
      const clones = sourceMaterials.map((source) => {
        const material = source.clone();
        if (instanceColors) material.vertexColors = true;
        return material;
      });
      return Array.isArray(mesh.material) ? clones : clones[0];
    };

    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const im = mesh as THREE.InstancedMesh;
      const pieces: THREE.BufferGeometry[] = [];
      const tmp = new THREE.Matrix4();
      const tint = new THREE.Color();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, tmp);
        let g = im.geometry.clone();
        if (im.instanceColor && Array.isArray(mesh.material) && g.index) {
          const indexed = g;
          g = indexed.toNonIndexed();
          indexed.dispose();
        }
        g.applyMatrix4(tmp);
        if (im.instanceColor) {
          im.getColorAt(i, tint);
          const existing = g.getAttribute('color');
          const count = g.getAttribute('position').count;
          const size = existing?.itemSize === 4 ? 4 : 3;
          const colors = new Float32Array(count * size);
          const vertexColorsEnabled = new Uint8Array(count).fill(
            sourceMaterials[0].vertexColors ? 1 : 0,
          );
          if (Array.isArray(mesh.material)) {
            for (const group of g.groups)
              vertexColorsEnabled.fill(
                sourceMaterials[group.materialIndex ?? 0]?.vertexColors ? 1 : 0,
                group.start,
                Math.min(count, group.start + group.count),
              );
          }
          for (let v = 0; v < count; v++) {
            // Instance tint multiplies vertex colors only on materials that use them.
            const useVertexColor = vertexColorsEnabled[v] === 1;
            colors[v * size] = tint.r * (existing && useVertexColor ? existing.getX(v) : 1);
            colors[v * size + 1] = tint.g * (existing && useVertexColor ? existing.getY(v) : 1);
            colors[v * size + 2] = tint.b * (existing && useVertexColor ? existing.getZ(v) : 1);
            if (size === 4)
              colors[v * size + 3] = existing && useVertexColor ? existing.getW(v) : 1;
          }
          g.setAttribute('color', new THREE.BufferAttribute(colors, size));
        }
        pieces.push(g);
      }
      if (pieces.length === 0) return;
      const merged = mergeGeometries(pieces, false);
      // mergeGeometries discards source groups unless rebuilt explicitly.
      if (merged && Array.isArray(mesh.material)) {
        let offset = 0;
        for (const piece of pieces) {
          for (const group of piece.groups)
            merged.addGroup(offset + group.start, group.count, group.materialIndex);
          offset += piece.index?.count ?? piece.attributes.position.count;
        }
      }
      pieces.forEach((p) => p.dispose());
      if (!merged) return;
      merged.applyMatrix4(im.matrixWorld);
      const out = new THREE.Mesh(merged, cloneMaterials(!!im.instanceColor));
      out.name = im.name || 'instanced';
      baked.add(out);
    } else {
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      const out = new THREE.Mesh(g, cloneMaterials());
      out.name = mesh.name || 'mesh';
      baked.add(out);
    }
  });
  return baked;
}

function disposeGroup(group: THREE.Group) {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material.dispose());
    }
  });
}

export async function exportGLTF(root: THREE.Object3D, filename: string): Promise<void> {
  const baked = bakeWorldGroup(root);
  try {
    const result = await new GLTFExporter().parseAsync(baked, { binary: true });
    const blob =
      result instanceof ArrayBuffer
        ? new Blob([result], { type: 'model/gltf-binary' })
        : new Blob([JSON.stringify(result)], { type: 'model/gltf+json' });
    downloadBlob(blob, filename);
  } finally {
    disposeGroup(baked);
  }
}

export function exportOBJ(root: THREE.Object3D, filename: string) {
  const baked = bakeWorldGroup(root);
  try {
    const text = new OBJExporter().parse(baked);
    downloadBlob(new Blob([text], { type: 'text/plain' }), filename);
  } finally {
    disposeGroup(baked);
  }
}

export function captureScreenshot(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('The renderer could not capture an image'));
        return;
      }
      try {
        downloadBlob(blob, filename);
        resolve();
      } catch (err) {
        reject(err);
      }
    }, 'image/png');
  });
}
