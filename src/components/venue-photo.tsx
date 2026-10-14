"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import Image from "next/image";

/**
 * A venue photo that falls back when it can't load (an unreachable photo
 * service, a photo removed upstream), so the card shows its "no photo" state
 * instead of a broken image with its alt text spilling over the layout.
 */
export function VenuePhoto({ fallback = null, ...props }: ComponentProps<typeof Image> & { fallback?: ReactNode }) {
  const [failedSrc, setFailedSrc] = useState<ComponentProps<typeof Image>["src"] | null>(null);
  if (failedSrc === props.src) return <>{fallback}</>;
  // eslint-disable-next-line jsx-a11y/alt-text -- alt is required by Image's props and passed through
  return <Image {...props} onError={() => setFailedSrc(props.src)} />;
}
