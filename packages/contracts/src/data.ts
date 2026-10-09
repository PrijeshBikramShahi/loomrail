import { z } from 'zod';
import { idSchema } from './graph.js';
export const csvImportSchema = z.strictObject({ csv: z.string().min(1).max(250000) });
export const knowledgeImportSchema = z.strictObject({ sourceId: idSchema.optional(), name: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(100000) });
export const knowledgeSearchSchema = z.strictObject({ versionIds: z.array(idSchema).max(20), query: z.string().min(1).max(500) });
