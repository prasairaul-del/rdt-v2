import { z } from 'zod';

export const FileSelectionSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
      priority: z.enum(['high', 'medium', 'low']),
    }),
  ),
  confidence: z.number(),
});

export const PlanSchema = z.object({
  summary: z.string(),
  steps: z.array(
    z.object({
      description: z.string(),
      targetFiles: z.array(z.string()),
      risk: z.enum(['low', 'medium', 'high']),
    }),
  ),
  testPlan: z.array(z.string()),
  risks: z.array(z.string()),
});

export const EditResultSchema = z.object({
  summary: z.string().optional(),
  edits: z.array(
    z.object({
      file: z.string(),
      patch: z.string().optional(),
      content: z.string().optional(),
    }),
  ),
});

export const ReviewResultSchema = z.object({
  approved: z.boolean(),
  summary: z.string().optional(),
  issues: z.array(z.string()).optional(),
  requiredFixes: z.array(z.string()).optional(),
});
