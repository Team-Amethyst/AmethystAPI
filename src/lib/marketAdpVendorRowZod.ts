import { z } from "zod";

/** External vendor row after normalization (before catalog match). */
export const marketAdpVendorRowZod = z.object({
  mlb_id: z.union([z.number().int().positive(), z.null()]).optional(),
  name: z.string().min(1),
  team: z.string(),
  position: z.string(),
  adp: z.number().finite().positive(),
  adp_min: z.number().finite().nullable().optional(),
  adp_max: z.number().finite().nullable().optional(),
  sample_size: z.number().finite().int().nonnegative().nullable().optional(),
});

export type MarketAdpVendorRowValidated = z.infer<typeof marketAdpVendorRowZod>;
