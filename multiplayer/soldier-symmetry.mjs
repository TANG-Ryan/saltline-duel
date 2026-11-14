/** Reflection across the character sagittal plane X=0. Transform order matters:
 * S(Rv+p) = (SRS)(Sv)+Sp. A left-handed reflection is never used as a rotation.
 */
export const mirrorPoint = point => [-point[0], point[1], point[2]];
export const BODY_DIMENSIONS = Object.freeze({
  shoulderHalf: .205, shoulderY: .572, shoulderZ: -.015,
  hipHalf: .115, thigh: .395, shin: .382, hipY: .86,
  pocketPitch: .081, pocketWidth: .074, layerClearance: .003,
});

export function symmetricOutline(rightHalf) {
  return [...rightHalf.map(point => point.slice()), ...rightHalf.slice().reverse().filter(p => Math.abs(p[0]) > 1e-9).map(([x, y]) => [-x, y])];
}

export function createSymmetrySystem(T, own) {
  const cache = new WeakMap(), pairs = [];
  const mirrorRotation = (rotation = [0, 0, 0]) => {
    const order = rotation[3] || 'XYZ';
    const q = new T.Quaternion().setFromEuler(new T.Euler(rotation[0], rotation[1], rotation[2], order));
    // q' = (qx,-qy,-qz,qw) is S*R(q)*S for reflection in the X axis.
    q.set(q.x, -q.y, -q.z, q.w);
    const e = new T.Euler().setFromQuaternion(q, order);
    return [e.x, e.y, e.z];
  };
  const reflectGeometry = source => {
    if (cache.has(source)) return cache.get(source);
    const geometry = source.clone();
    const p = geometry.attributes.position, n = geometry.attributes.normal, tangent = geometry.attributes.tangent;
    for (let i = 0; i < p.count; i++) {
      p.setX(i, -p.getX(i));
      if (n) n.setX(i, -n.getX(i));
      if (tangent) { tangent.setX(i, -tangent.getX(i)); tangent.setW(i, -tangent.getW(i)); }
    }
    if (geometry.index) {
      const indices = geometry.index;
      for (let i = 0; i < indices.count; i += 3) {
        const b = indices.getX(i + 1), c = indices.getX(i + 2);
        indices.setX(i + 1, c); indices.setX(i + 2, b);
      }
    } else {
      // Keep every attribute aligned when reversing triangle winding.
      for (const attribute of Object.values(geometry.attributes)) for (let i = 0; i < attribute.count; i += 3) {
        for (let axis = 0; axis < attribute.itemSize; axis++) {
          const b = (i + 1) * attribute.itemSize + axis, c = (i + 2) * attribute.itemSize + axis;
          [attribute.array[b], attribute.array[c]] = [attribute.array[c], attribute.array[b]];
        }
      }
    }
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    own(geometry); cache.set(source, geometry);
    return geometry;
  };
  const pair = (emit, parent, geometry, material, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1], name = 'paired-part') => {
    const right = { geometry, material, position: position.slice(), rotation: rotation.slice(), scale: scale.slice() };
    const left = { geometry: reflectGeometry(geometry), material, position: mirrorPoint(position), rotation: mirrorRotation(rotation), scale: scale.slice() };
    emit(parent, right.geometry, material, right.position, right.rotation, right.scale);
    emit(parent, left.geometry, material, left.position, left.rotation, left.scale);
    pairs.push({ name, parent, right, left });
    return { right, left };
  };
  return { mirrorPoint, mirrorRotation, reflectGeometry, pair, pairs };
}
