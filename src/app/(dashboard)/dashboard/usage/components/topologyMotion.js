/** Motion policy for Usage topology; CSS media query also guards active strokes. */
export function topologyMotion(reducedMotion) {
  return { flow: !reducedMotion, fitDuration: reducedMotion ? 0 : 200 };
}
