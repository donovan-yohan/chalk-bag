import { z } from 'zod';

import { providerIds } from '../providers/registry.js';

export const providerIdSchema = z.enum(providerIds);

export const permissionModeSchema = z.enum(['allow', 'ask', 'deny']);

export const permissionRulesSchema = z
  .object({
    allow: z.array(z.string(), {
      error: '`allow` must be an array of strings',
    }).optional(),
    deny: z.array(z.string(), {
      error: '`deny` must be an array of strings',
    }).optional(),
    ask: z.array(z.string(), {
      error: '`ask` must be an array of strings',
    }).optional(),
  })
  .strict();

const pathPermissionRulesSchema = z
  .object({
    allow: z.array(z.string(), {
      error: '`allow` must be an array of strings',
    }).optional(),
    deny: z.array(z.string(), {
      error: '`deny` must be an array of strings',
    }).optional(),
  })
  .strict();

const sandboxSchema = z
  .object({
    mode: z
      .enum(['read-only', 'workspace-write', 'danger-full-access'])
      .optional(),
    networkAccess: z.boolean({
      error: '`networkAccess` must be a boolean',
    }).optional(),
  })
  .strict();

export const permissionsConfigSchema = z
  .object({
    bash: permissionRulesSchema.optional(),
    read: pathPermissionRulesSchema.optional(),
    write: pathPermissionRulesSchema.optional(),
    webfetch: pathPermissionRulesSchema.optional(),
    mcp: pathPermissionRulesSchema.optional(),
    defaultMode: z.enum(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']).optional(),
    sandbox: sandboxSchema.optional(),
    additionalRoots: z
      .array(z.string(), { error: '`additionalRoots` must be an array of strings' })
      .optional(),
  })
  .strict();

const targetsSchema = z.array(z.string()).superRefine((targets, context) => {
  for (const [index, target] of targets.entries()) {
    if (!providerIds.includes(target as (typeof providerIds)[number])) {
      context.addIssue({
        code: 'custom',
        message: `unknown target: ${target}. Valid targets: ${providerIds.join(', ')}`,
        path: [index],
      });
    }
  }
});

export const targetsFrontmatterSchema = z
  .object({
    targets: targetsSchema.optional(),
  })
  .passthrough();

const providerConfigSchema = z.object({
  enabled: z.boolean({
    error: '`enabled` must be a boolean',
  }),
});

export const permissionsBlockSchema = z
  .record(
    z.string(),
    z.object({
      allow: z.array(z.string(), { error: 'permission list must be an array of strings' }).optional(),
      deny: z.array(z.string(), { error: 'permission list must be an array of strings' }).optional(),
      ask: z.array(z.string(), { error: 'permission list must be an array of strings' }).optional(),
    }).strict(),
  )
  .optional();

export const skillFrontmatterSchema = z
  .object({
    name: z.string({
      error: '`name` must be a string',
    }),
    description: z.string({
      error: '`description` must be a string',
    }),
    targets: targetsSchema.optional(),
  })
  .passthrough();

export const subagentFrontmatterSchema = z
  .object({
    name: z.string({
      error: '`name` must be a string',
    }),
    description: z.string({
      error: '`description` must be a string',
    }),
    targets: targetsSchema.optional(),
  })
  .passthrough();

const importEntrySchema = z
  .object({
    source: z.string({ error: '`source` must be a string' }).refine(
      (value) => value.startsWith('github:'),
      { message: '`source` must use github:<owner>/<repo> format' },
    ),
    ref: z.string({ error: '`ref` must be a string' }),
    path: z.string({ error: '`path` must be a string' }).optional(),
  })
  .strict();

export const agentsConfigSchema = z
  .object({
    imports: z.array(importEntrySchema, {
      error: '`imports` must be an array of import entries',
    }).optional(),
  })
  .strict();

export const providersConfigSchema = z
  .object({
    providers: z.record(z.string(), providerConfigSchema),
    ignore: z.array(z.string()).optional(),
  })
  .superRefine((config, context) => {
    for (const providerName of Object.keys(config.providers)) {
      if (!providerIds.includes(providerName as (typeof providerIds)[number])) {
        context.addIssue({
          code: 'custom',
          message: `unknown provider target: ${providerName}. Valid targets: ${providerIds.join(', ')}`,
          path: ['providers', providerName],
        });
      }
    }
  });

export type TargetsFrontmatter = z.infer<typeof targetsFrontmatterSchema>;
export type SkillDocument = z.infer<typeof skillFrontmatterSchema>;
export type SubagentDocument = z.infer<typeof subagentFrontmatterSchema>;
export type ProvidersConfig = z.infer<typeof providersConfigSchema>;
export type PermissionsConfig = z.infer<typeof permissionsConfigSchema>;
export type AgentsConfig = z.infer<typeof agentsConfigSchema>;
export type ImportEntry = z.infer<typeof importEntrySchema>;
