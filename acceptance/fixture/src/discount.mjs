export function discountedTotal(price, percent) {
  if (!Number.isFinite(price) || !Number.isFinite(percent) || price < 0 || percent < 0 || percent > 100) {
    throw new TypeError("price must be non-negative and percent must be between 0 and 100");
  }
  return Math.round(price * (1 - percent / 100) * 100) / 100;
}
