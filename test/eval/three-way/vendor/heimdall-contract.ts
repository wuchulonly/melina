import { type Static, Type } from 'typebox';
import { Errors } from 'typebox/value';

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
// Some constrained decoders treat JSON Schema patterns as whole-string matches.
// A bare \\S then forces a single character; explicitly allow the surrounding text.
const text = (maxLength = 1200) => Type.String({ minLength: 1, maxLength, pattern: '^[\\s\\S]*\\S[\\s\\S]*$' });
const id = Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,79}$' });
const nullable = (max = 1200) => Type.Union([text(max), Type.Null()]);
const ref = Type.String({ pattern: '^(turn:[1-9][0-9]*|receipt:[a-f0-9]{64}|input:task|input:hint)$' });
const refs = Type.Array(ref, { minItems: 1, maxItems: 16, uniqueItems: true });
const ids = (max = 32) => Type.Array(id, { maxItems: max, uniqueItems: true });
const status = Type.Union([
  Type.Literal('inferred-open'),
  Type.Literal('tried-hit'),
  Type.Literal('tried-miss'),
  Type.Literal('scan-class'),
]);

export const AttemptSchema = object({
  id,
  action: text(),
  result: text(4000),
  assessment: Type.Optional(nullable()),
  evidenceRefs: refs,
});
export const AssessmentSchema = object({
  id,
  subject: text(120),
  status,
  conclusion: text(600),
  basis: text(),
  uncertainty: nullable(),
  evidenceRefs: refs,
  role: Type.Optional(Type.Union([Type.Literal('direction'), Type.Literal('endpoint'), Type.Literal('path')])),
  api: Type.Optional(text(120)),
  attempts: Type.Array(AttemptSchema, {
    maxItems: 20,
    description:
      'Use [] only for inferred-open judgments. tried-hit, tried-miss and scan-class require actual action/result records citing turn or receipt evidence.',
  }),
  dependsOn: Type.Optional(ids()),
});
export const GuidanceSchema = object({
  hypothesis: nullable(),
  lock: nullable(),
  angleIds: ids(4),
  confirmedIds: ids(8),
  tension: Type.Array(text(), { maxItems: 2 }),
});
export const LootSchema = object({
  bucket: Type.Union([
    Type.Literal('users'),
    Type.Literal('names'),
    Type.Literal('passwords'),
    Type.Literal('hosts'),
    Type.Literal('patterns'),
    Type.Literal('password_patterns'),
    Type.Literal('creds'),
    Type.Literal('org_names'),
    Type.Literal('products'),
    Type.Literal('emails'),
  ]),
  value: text(),
  evidenceRefs: refs,
});
export const SubmitSchema = object({
  baseRevision: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  upserts: Type.Array(AssessmentSchema, { maxItems: 30 }),
  retireIds: ids(),
  guidance: Type.Optional(GuidanceSchema),
  loot: Type.Optional(Type.Array(LootSchema, { maxItems: 100 })),
});
export const ContextSchema = object({
  evidenceRefs: Type.Optional(Type.Array(ref, { maxItems: 16, uniqueItems: true })),
  assessmentIds: Type.Optional(ids(8)),
});
export type Assessment = Static<typeof AssessmentSchema>;
export type Guidance = Static<typeof GuidanceSchema>;
export type LootItem = Static<typeof LootSchema>;
export type ObservationSubmit = Static<typeof SubmitSchema>;
export type Issue = { path: string; code: string; message: string };

/** Used in the effective prompt and validated in tests against the same tool schema. */
export const OBSERVATION_EXAMPLE: ObservationSubmit = {
  baseRevision: null,
  upserts: [
    {
      id: 'auth-logic',
      subject: 'Authentication logic',
      status: 'inferred-open',
      role: 'direction',
      conclusion: 'The task describes a login surface; authentication logic remains untried.',
      basis: 'Replace this example with the actual task facts and log evidence.',
      uncertainty: 'No execution evidence yet.',
      evidenceRefs: ['input:task'],
      attempts: [],
      dependsOn: [],
    },
  ],
  retireIds: [],
  guidance: { hypothesis: null, lock: null, angleIds: ['auth-logic'], confirmedIds: [], tension: [] },
};

export const OBSERVATION_TRIED_EXAMPLE: ObservationSubmit = {
  baseRevision: null,
  upserts: [
    {
      id: 'login-response',
      subject: 'Login response',
      status: 'tried-miss',
      conclusion: 'The tested login input was rejected.',
      basis: 'The response in the cited turn reports invalid credentials.',
      uncertainty: 'Other authentication paths remain untested.',
      evidenceRefs: ['turn:1'],
      attempts: [
        {
          id: 'login-check',
          action: 'Test a login input',
          result: 'The response reported invalid credentials.',
          evidenceRefs: ['turn:1'],
        },
      ],
    },
  ],
  retireIds: [],
  guidance: { hypothesis: null, lock: null, angleIds: [], confirmedIds: ['login-response'], tension: [] },
};

export class ObservationValidationError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(JSON.stringify({ ok: false, errors: issues }));
    this.issues = issues;
  }
}

/** Same schema feeds the model tool and runtime validation; report all failures, including misplaced fields. */
export function parseSubmission(raw: unknown): ObservationSubmit {
  const issues: Issue[] = Errors(SubmitSchema, raw).flatMap((error) => {
    const params = error.params as Record<string, unknown>;
    const keys = (params.requiredProperties || params.additionalProperties) as string[] | undefined;
    return (keys || ['']).map((key) => ({
      path: `${error.instancePath}${key ? `/${key}` : ''}`,
      code: error.keyword,
      message: `${error.message}${key ? `: ${key}` : ''}`,
    }));
  });
  if (raw && typeof raw === 'object' && Array.isArray((raw as { upserts?: unknown }).upserts)) {
    for (const [index, item] of (raw as { upserts: unknown[] }).upserts.entries()) {
      if (!item || typeof item !== 'object') continue;
      const nested = (item as { summary?: Record<string, unknown> }).summary;
      if (nested && typeof nested === 'object')
        for (const field of ['evidenceRefs', 'steps', 'attempts']) {
          if (field in nested)
            issues.push({
              path: `/upserts/${index}/${field === 'steps' ? 'attempts' : field}`,
              code: 'misplaced_field',
              message: `Found summary.${field}; submit flat assessment fields (attempts, evidenceRefs).`,
            });
        }
    }
  }
  if (issues.length) throw new ObservationValidationError(issues);
  return structuredClone(raw) as ObservationSubmit;
}
