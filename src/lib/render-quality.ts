import type { QualityLevel } from '@/config/constants';

/** Deterministic spatially distributed thinning without modifying the generated world. */
export function selectDetailInstances<T>(instances: T[], fraction: number): T[] {
  if (fraction >= 1) return instances;
  if (fraction <= 0) return [];
  return instances.filter((_, i) => {
    let hash = Math.imul(i + 1, 0x9e3779b1);
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash ^= hash >>> 13;
    return (hash >>> 0) / 4294967296 < fraction;
  });
}

/** Require sustained slow rendering after warmup; ignore tab suspension and hitches. */
export class AdaptiveQuality {
  private previous: QualityLevel | null = null;
  private cooldown = 4;
  private slowSeconds = 0;

  sample(
    delta: number,
    fps: number,
    quality: QualityLevel,
    enabled: boolean,
    visible: boolean,
  ): QualityLevel | null {
    if (quality !== this.previous || !enabled || !visible || delta > 0.25) {
      this.previous = quality;
      this.cooldown = 4;
      this.slowSeconds = 0;
      return null;
    }
    if (quality === 'mobile' || delta <= 0) return null;
    if (this.cooldown > 0) {
      this.cooldown -= delta;
      return null;
    }
    this.slowSeconds =
      fps < 27 ? this.slowSeconds + delta : Math.max(0, this.slowSeconds - delta * 0.5);
    if (this.slowSeconds < 5) return null;
    this.slowSeconds = 0;
    this.cooldown = 4;
    return quality === 'quality' ? 'balanced' : 'mobile';
  }
}
