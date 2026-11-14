export function nextPowerOfTwo(n) {
  let power = 1;
  while (power <= n) power *= 2;
  return power;
}
