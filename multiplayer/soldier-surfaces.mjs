/** Procedural asset tools following the bundled weapon's bevel/loft/batch/detail approach. */
export function createSoldierSurfaceKit(T) {
  const geometries = new Set();
  const cache = new Map();
  const keep = geometry => (geometries.add(geometry), geometry);
  const memo = (key, build) => {
    if (!cache.has(key)) cache.set(key, keep(build()));
    return cache.get(key);
  };
  // Small tileable, deterministic data maps. Mipmapping filters fibres and
  // grain in distance; UVs are expressed in metres when the parts are batched.
  const textures = [];
  function tile(kind) {
    const size = 64, bumps = new Uint8Array(size * size * 4), rough = new Uint8Array(bumps.length);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const hash = ((Math.imul(x + 7, 1597334677) ^ Math.imul(y + 13, 3812015801)) >>> 12) / 1048575;
      const weave = Math.sin(x * Math.PI / 4) * Math.sin(y * Math.PI / 4) * (kind === 'cloth' ? 0.18 : 0.035);
      const h = 0.5 + weave + (hash - 0.5) * 0.15;
      bumps.set([h * 255, h * 255, h * 255, 255], i);
      const r = 214 + 34 * h;
      rough.set([r, r, r, 255], i);
    }
    return [bumps, rough].map(bytes => {
      const texture = new T.DataTexture(bytes, size, size);
      texture.wrapS = texture.wrapT = T.RepeatWrapping;
      texture.repeat.set(54, 54);
      texture.magFilter = T.LinearFilter;
      texture.minFilter = T.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      textures.push(texture);
      return texture;
    });
  }
  const clothTile = tile('cloth'), leatherTile = tile('leather');
  const surface = (name, color, roughness, metalness, kind) => {
    const material = new T.MeshStandardMaterial({ color, roughness, metalness });
    material.name = `soldier_${name}`;
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
        varying vec3 vSoldierPosition;
        varying vec3 vSoldierNormal;
      `).replace('#include <begin_vertex>', `#include <begin_vertex>
        vSoldierPosition = position;
        vSoldierNormal = normal;
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vSoldierPosition;
        varying vec3 vSoldierNormal;
        float soldierHash(vec3 p) {
          return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        }
        float soldierNoise(vec3 p) {
          vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(soldierHash(i), soldierHash(i + vec3(1,0,0)), f.x),
                         mix(soldierHash(i + vec3(0,1,0)), soldierHash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(soldierHash(i + vec3(0,0,1)), soldierHash(i + vec3(1,0,1)), f.x),
                         mix(soldierHash(i + vec3(0,1,1)), soldierHash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        vec3 soldierBump(vec3 N, float height) {
          vec3 px = dFdx(-vViewPosition), py = dFdy(-vViewPosition);
          vec3 rx = cross(py, N), ry = cross(N, px);
          float determinant = dot(px, rx);
          return normalize(abs(determinant) * N - sign(determinant) *
            (dFdx(height) * rx + dFdy(height) * ry));
        }
      `).replace('#include <color_fragment>', `#include <color_fragment>
        vec3 soldierP = vSoldierPosition;
        vec3 soldierN = normalize(vSoldierNormal);
        vec3 soldierWeight = pow(abs(soldierN), vec3(4.0));
        soldierWeight /= max(dot(soldierWeight, vec3(1.0)), 0.0001);
        float soldierPixel = max(length(dFdx(soldierP)), length(dFdy(soldierP)));
        float soldierFine = 1.0 - smoothstep(0.00025, 0.0014, soldierPixel);
        float soldierMacro = soldierNoise(soldierP * 38.0 + 2.3);
        float soldierGrain = (soldierHash(floor(soldierP * 1900.0)) - 0.5) * soldierFine;
        float soldierWeave = dot(vec3(sin(soldierP.y * 5400.0) * sin(soldierP.z * 5400.0),
          sin(soldierP.x * 5400.0) * sin(soldierP.z * 5400.0),
          sin(soldierP.x * 5400.0) * sin(soldierP.y * 5400.0)), soldierWeight) * soldierFine;
        float soldierHeight = 0.0;
        float soldierRough = (soldierMacro - 0.5) * 0.11;
        // The weapon similarly fades subpixel machining/grip detail into roughness.
        ${kind === 0 ? `
          vec3 grid = abs(fract(soldierP / 0.014) - 0.5);
          vec3 ripstop = 1.0 - smoothstep(vec3(0.025), vec3(0.065), grid);
          float gridFilter = 1.0 - smoothstep(0.001, 0.004, soldierPixel);
          float seams = dot(vec3(max(ripstop.y, ripstop.z), max(ripstop.x, ripstop.z),
            max(ripstop.x, ripstop.y)), soldierWeight) * gridFilter;
          diffuseColor.rgb *= 0.87 + soldierMacro * 0.22 + soldierWeave * 0.055 - seams * 0.035;
          soldierHeight = soldierWeave * 0.000065 + seams * 0.00007;
          soldierRough += soldierWeave * 0.035;
        ` : kind === 3 ? `
          float worn = smoothstep(0.08, 0.42, length(fwidth(soldierN))) *
            smoothstep(0.38, 0.78, soldierMacro);
          diffuseColor.rgb = mix(diffuseColor.rgb * (0.92 + soldierMacro * 0.16),
            vec3(0.32, 0.34, 0.33), worn * 0.5);
          soldierRough -= worn * 0.13;
          soldierHeight = soldierGrain * 0.000018;
        ` : kind === 4 ? `
          diffuseColor.rgb *= 0.96 + soldierMacro * 0.08;
          soldierRough *= 0.2;
        ` : `
          diffuseColor.rgb *= 0.91 + soldierMacro * 0.18 + soldierGrain * 0.035;
          soldierHeight = soldierGrain * ${kind === 2 ? '0.00004' : '0.000025'};
        `}
      `).replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + soldierRough, 0.075, 1.0);
      `).replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = soldierBump(normal, soldierHeight);
      `);
    };
    material.customProgramCacheKey = () => `saltline-soldier-surface-1-${kind}`;
    return material;
  };
  const materials = {
    fabric: surface('ripstop', 0x4a4b46, 0.91, 0, 0),
    fabricDark: surface('dark_ripstop', 0x353632, 0.93, 0, 0),
    webbing: surface('woven_webbing', 0x6a6149, 0.93, 0, 0),
    webbingDark: surface('dark_webbing', 0x494233, 0.95, 0, 0),
    armor: surface('composite_armor', 0x494c3e, 0.78, 0, 1),
    polymer: surface('moulded_polymer', 0x30302b, 0.63, 0, 1),
    rubber: surface('moulded_rubber', 0x292722, 0.88, 0, 2),
    metal: surface('phosphate_steel', 0x57554d, 0.66, 0.2, 3),
    lens: surface('smoked_polycarbonate', 0x202421, 0.15, 0.25, 4),
    accent: surface('faded_identification', 0xb79c64, 0.79, 0, 0),
    stitch: surface('seam_thread', 0x837961, 0.96, 0, 0),
    leather: surface('boot_leather', 0x3e3a30, 0.74, 0, 2),
  };
  for (const [material, maps, bumpScale] of [[materials.fabric, clothTile, 0.00022], [materials.fabricDark, clothTile, 0.00022], [materials.webbing, clothTile, 0.0003], [materials.webbingDark, clothTile, 0.0003], [materials.leather, leatherTile, 0.00045]]) {
    [material.bumpMap, material.roughnessMap] = maps;
    material.bumpScale = bumpScale;
  }

  function rounded(w, h, d, radius = 0.02) {
    return memo(`round:${w},${h},${d},${radius}`, () => {
      // Same three-interval chamfer construction as the original Ei weapon helper.
      const r = Math.max(0.00001, Math.min(radius, w / 2 - 0.00001, h / 2 - 0.00001, d / 2 - 0.00001));
      const geometry = new T.BoxGeometry(w, h, d, 3, 3, 3);
      const p = geometry.attributes.position, n = geometry.attributes.normal, uv = geometry.attributes.uv;
      const half = [w / 2, h / 2, d / 2];
      const direction = new T.Vector3();
      for (let i = 0; i < p.count; i++) {
        const value = [p.getX(i), p.getY(i), p.getZ(i)].map((v, a) =>
          Math.sign(v) * (Math.abs(v) > half[a] - 0.000001 ? half[a] : half[a] - r));
        const core = value.map((v, a) => T.MathUtils.clamp(v, -half[a] + r, half[a] - r));
        direction.set(value[0] - core[0], value[1] - core[1], value[2] - core[2]).normalize();
        p.setXYZ(i, core[0] + direction.x * r, core[1] + direction.y * r, core[2] + direction.z * r);
        n.setXYZ(i, direction.x, direction.y, direction.z);
        const a = [Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)];
        uv.setXY(i, a[0] >= a[1] && a[0] >= a[2] ? value[2] : value[0],
          a[1] >= a[0] && a[1] >= a[2] ? value[2] : value[1]);
      }
      geometry.computeBoundingSphere();
      return geometry;
    });
  }

  function loft(rings, segments = 12) {
    return memo(`loft:${segments}:${JSON.stringify(rings)}`, () => {
      const positions = [], uvs = [], indices = [];
      const ordered = [...rings].sort((a, b) => a.y - b.y);
      for (const ring of ordered) {
        for (let j = 0; j <= segments; j++) {
          const angle = j / segments * Math.PI * 2;
          positions.push((ring.x || 0) + Math.cos(angle) * ring.rx, ring.y,
            (ring.z || 0) + Math.sin(angle) * ring.rz);
          uvs.push(j / segments, ring.y);
        }
      }
      for (let i = 0; i < ordered.length - 1; i++) {
        for (let j = 0; j < segments; j++) {
          const a = i * (segments + 1) + j, b = a + 1, c = a + segments + 1, d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
      // Separate cap rings retain hard normals at collars, boot soles and plate ends.
      for (const end of [0, ordered.length - 1]) {
        const ring = ordered[end], base = positions.length / 3;
        positions.push(ring.x || 0, ring.y, ring.z || 0); uvs.push(0.5, 0.5);
        for (let j = 0; j <= segments; j++) {
          const angle = j / segments * Math.PI * 2;
          positions.push((ring.x || 0) + Math.cos(angle) * ring.rx, ring.y,
            (ring.z || 0) + Math.sin(angle) * ring.rz);
          uvs.push(0.5 + Math.cos(angle) * 0.5, 0.5 + Math.sin(angle) * 0.5);
          if (j < segments) indices.push(base, base + j + (end ? 2 : 1), base + j + (end ? 1 : 2));
        }
      }
      const geometry = new T.BufferGeometry();
      geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices); geometry.computeVertexNormals();
      const normal = geometry.attributes.normal, average = new T.Vector3();
      for (let i = 0; i < ordered.length; i++) {
        const first = i * (segments + 1), last = first + segments;
        average.fromBufferAttribute(normal, first).add(new T.Vector3().fromBufferAttribute(normal, last)).normalize();
        normal.setXYZ(first, average.x, average.y, average.z); normal.setXYZ(last, average.x, average.y, average.z);
      }
      geometry.computeBoundingSphere();
      return geometry;
    });
  }

  function tube(points, radius, segments = 6) {
    const values = points.map(p => p.isVector3 ? p.toArray() : p);
    return memo(`tube:${radius}:${segments}:${JSON.stringify(values)}`, () => {
      const curve = new T.CatmullRomCurve3(values.map(p => new T.Vector3(...p)), false, 'centripetal');
      const length = curve.getLength();
      const geometry = new T.TubeGeometry(curve, Math.max(2, Math.min(96, Math.ceil(length / 0.025))), radius, segments, false);
      const uv = geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * length, uv.getY(i) * Math.PI * 2 * radius);
      return geometry;
    });
  }

  function batch(parent, parts, name = 'soldier-batch') {
    const buckets = new Map();
    const rotation = new T.Euler(), quaternion = new T.Quaternion(), matrix = new T.Matrix4();
    for (const part of parts) {
      const material = typeof part.material === 'string' ? materials[part.material] : part.material;
      if (!material || !part.geometry) throw new Error(`Invalid material/geometry in ${name}`);
      rotation.set(...(part.rotation || [0, 0, 0])); quaternion.setFromEuler(rotation);
      matrix.compose(new T.Vector3(...(part.position || [0, 0, 0])), quaternion,
        new T.Vector3(...(part.scale || [1, 1, 1])));
      const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
      geometry.applyMatrix4(matrix);
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      if (matrix.determinant() < 0) {
        // A merged mirrored part needs reversed winding as its object matrix is now identity.
        for (const attribute of Object.values(geometry.attributes)) {
          for (let i = 0; i < attribute.count; i += 3) {
            for (let axis = 0; axis < attribute.itemSize; axis++) {
              const a = (i + 1) * attribute.itemSize + axis, b = (i + 2) * attribute.itemSize + axis;
              [attribute.array[a], attribute.array[b]] = [attribute.array[b], attribute.array[a]];
            }
          }
        }
      }
      if (!buckets.has(material)) buckets.set(material, []);
      buckets.get(material).push(geometry);
    }
    const meshes = [];
    for (const [material, sources] of buckets) {
      const count = sources.reduce((total, g) => total + g.attributes.position.count, 0);
      const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), uvs = new Float32Array(count * 2);
      let offset = 0;
      for (const geometry of sources) {
        positions.set(geometry.attributes.position.array, offset * 3);
        normals.set(geometry.attributes.normal.array, offset * 3);
        // Tileable material UV projection in object metres. Preserve the
        // geometry's own UVs on unbatched, deforming garment sections.
        for (let i = 0; i < geometry.attributes.position.count; i++) {
          const p = geometry.attributes.position, n = geometry.attributes.normal;
          const x = Math.abs(n.getX(i)), y = Math.abs(n.getY(i)), z = Math.abs(n.getZ(i));
          uvs[(offset + i) * 2] = x > Math.max(y, z) ? p.getZ(i) : p.getX(i);
          uvs[(offset + i) * 2 + 1] = y > Math.max(x, z) ? p.getZ(i) : p.getY(i);
        }
        offset += geometry.attributes.position.count; geometry.dispose();
      }
      const geometry = keep(new T.BufferGeometry());
      geometry.setAttribute('position', new T.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new T.BufferAttribute(normals, 3));
      geometry.setAttribute('uv', new T.BufferAttribute(uvs, 2)); geometry.computeBoundingSphere();
      const mesh = new T.Mesh(geometry, material);
      mesh.name = `${name}-${material.name}`; mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh); meshes.push(mesh);
    }
    return meshes;
  }

  return { materials, rounded, loft, tube, batch, dispose() {
    for (const geometry of geometries) geometry.dispose();
    for (const material of Object.values(materials)) material.dispose();
    for (const texture of textures) texture.dispose();
    geometries.clear(); cache.clear();
  } };
}
