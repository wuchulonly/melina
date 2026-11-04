// 同一工作区的交付一致性：区域缓存、素材别名、历史版本发布。
import { json, noRoute } from '../../sim/kit/http.ts';
import { Rng } from '../../sim/kit/rng.ts';
import { object, type ScenarioFixture } from './kit.ts';

export function cacheFixture(seed: string): ScenarioFixture {
  const rng = new Rng(`cache-consistency/${seed}`);
  const target = { product_id: `P-${rng.hex(8)}`, requested_price_cents: rng.int(2_000, 4_000) };
  const initialPrice = target.requested_price_cents - rng.int(100, 900);
  const extensions = ['.csv', '.json', '.txt'];
  const cachedExtension = rng.pick(extensions);
  const regions = ['eu', 'us', 'ap'];
  const scopes = ['path', 'region', 'catalog', 'distribution'];
  const completeScope = rng.pick(scopes.slice(1));
  const checksums = [`price-${rng.hex(20)}`, `price-${rng.hex(20)}`];
  return {
    handover: {
      target,
      baseline: { method: 'GET', path: `/edge/products/${target.product_id}/content.json?expect_revision=2` },
    },
    truth: {
      target,
      cachedExtension,
      completeScope,
      checksum: checksums[1],
      mechanism: '兼容后缀和区域都参与缓存索引，部分失效范围不会清掉所有副本',
    },
    open() {
      let revision = 1;
      let price = initialPrice;
      let normalRead = false;
      let staleObserved = false;
      let narrowObserved = false;
      let invalidRejected = false;
      let completeApplied = false;
      const finalReads = new Set<string>();
      const cache = new Map<string, { revision: number; price_cents: number; checksum: string }>();
      const current = () => ({ revision, price_cents: price, checksum: checksums[revision - 1]! });
      return {
        handle(req) {
          if (req.method === 'GET' && req.path === '/api')
            return json(200, {
              product: `/api/products/${target.product_id}`,
              edge: `/edge/products/${target.product_id}`,
              compatibility_suffixes: extensions.map((extension) => `/content${extension}`),
              regions,
              region_header: 'x-edge-region',
              consistency_query: 'expect_revision',
              update: { path: `/api/products/${target.product_id}`, method: 'PUT', body: ['price_cents'] },
              invalidate: '/api/cache/invalidate',
              invalidate_body: ['product_id', 'scope', 'region'],
              scopes,
            });
          if (req.path === `/api/products/${target.product_id}`) {
            if (req.method === 'GET') {
              if (revision === 1) normalRead = true;
              return json(200, { product_id: target.product_id, ...current(), delivery: 'origin' });
            }
            if (req.method === 'PUT') {
              const value = object(req.body).price_cents;
              if (value !== target.requested_price_cents) return json(400, { error: 'requested_price_required' });
              price = Number(value);
              revision = 2;
              return json(200, { product_id: target.product_id, ...current() });
            }
          }
          const edge = /^\/edge\/products\/([^/]+)(\/content\.[a-z]+)$/.exec(req.path);
          if (req.method === 'GET' && edge) {
            const region = req.headers['x-edge-region'] ?? regions[0]!;
            if (
              edge[1] !== target.product_id ||
              !regions.includes(region) ||
              !extensions.some((extension) => edge[2] === `/content${extension}`)
            )
              return json(400, { error: 'edge_parameters' });
            const key = `${region}:${req.path}`;
            const cached = edge[2] === `/content${cachedExtension}`;
            if (cached && !cache.has(key)) cache.set(key, current());
            const data = cached ? cache.get(key)! : current();
            const expected = req.query.get('expect_revision');
            if (expected !== null && Number(expected) !== data.revision) {
              if (revision === 2 && data.revision === 1) staleObserved = true;
              return json(409, {
                error: 'revision_mismatch',
                actual: { product_id: target.product_id, ...data, region },
              });
            }
            if (cached && revision === 2 && data.revision === 2) finalReads.add(region);
            return json(200, { product_id: target.product_id, ...data, region, delivery: cached ? 'cache' : 'origin' });
          }
          if (req.method === 'POST' && req.path === '/api/cache/invalidate') {
            const body = object(req.body);
            if (
              body.product_id !== target.product_id ||
              !scopes.includes(String(body.scope)) ||
              !regions.includes(String(body.region))
            ) {
              invalidRejected = true;
              return json(400, { error: 'invalidation_parameters' });
            }
            let removed = 0;
            for (const key of [...cache.keys()]) {
              if (body.scope === completeScope || (body.scope !== 'path' && key.startsWith(`${body.region}:`))) {
                cache.delete(key);
                removed++;
              }
            }
            if (body.scope === completeScope && revision === 2) completeApplied = true;
            else if (revision === 2 && [...cache.values()].some((value) => value.revision === 1)) narrowObserved = true;
            return json(200, { scope: body.scope, removed });
          }
          return noRoute();
        },
        judge(answer) {
          const expectedPath = `/edge/products/${target.product_id}/content${cachedExtension}`;
          if (
            answer.product_id !== target.product_id ||
            answer.revision !== 2 ||
            answer.price_cents !== target.requested_price_cents ||
            answer.checksum !== checksums[1] ||
            answer.stale_path !== expectedPath ||
            answer.scope !== completeScope ||
            !completeApplied ||
            finalReads.size !== regions.length ||
            regions.some((region) => cache.get(`${region}:${expectedPath}`)?.revision !== 2)
          )
            return '商品更新后并非所有区域副本都已达到目标版本';
          if (!normalRead || !staleObserved || !narrowObserved || !invalidRejected)
            return '缺少普通读取、陈旧响应、局部失效和非法参数的对照';
          return undefined;
        },
      };
    },
  };
}

export function aliasFixture(seed: string): ScenarioFixture {
  const rng = new Rng(`resource-alias/${seed}`);
  const current = rng.int(3, 5);
  const aliases = [0, 1, 2].map(() => `A-${rng.hex(8)}`);
  const resource = `M-${rng.hex(8)}`;
  const target = { alias_id: aliases[0]!, revision: rng.int(1, current - 1) };
  const profiles = ['current', 'preserve', 'compat'];
  const pinnedProfile = rng.pick(profiles);
  const lag = rng.int(2, 4);
  const checksums = Array.from({ length: current }, () => `asset-${rng.hex(20)}`);
  const text = (revision: number) => `edition=${revision}\ncontent_checksum=${checksums[revision - 1]}\n`;
  return {
    handover: {
      target,
      baseline: {
        method: 'POST',
        path: '/api/renders',
        body: { resource_id: target.alias_id, format: 'text', profile: profiles[0] },
      },
    },
    truth: {
      target,
      resource,
      checksums,
      pinnedProfile,
      lag,
      mechanism: '多级素材别名携带版本意图，只有保留版本上下文的渲染档位使用指定修订',
    },
    open() {
      const jobs = new Map<
        string,
        { initial: string; revision: number; format: string; polls: number; profile: string }
      >();
      let sequence = 0;
      let normalRead = false;
      let unknownRejected = false;
      let thumbnailRead = false;
      let latestObserved = false;
      const targetJobs = new Set<string>();
      return {
        handle(req) {
          if (req.method === 'GET' && req.path === '/api')
            return json(200, {
              aliases: '/api/aliases/:id',
              resources: '/api/resources/:id',
              renders: '/api/renders',
              profiles,
              formats: ['thumbnail', 'text'],
              render_body: ['resource_id', 'revision', 'format', 'profile'],
              scheduling: '资源编号仅查本实例的素材表；查询渲染作业推进一个周期',
            });
          const alias = /^\/api\/aliases\/([^/]+)$/.exec(req.path);
          if (req.method === 'GET' && alias) {
            const index = aliases.indexOf(alias[1]!);
            if (index < 0) return json(404, { error: 'alias_missing' });
            return json(200, {
              alias_id: alias[1],
              next_resource: aliases[index + 1] ?? resource,
              revision: target.revision,
            });
          }
          if (req.method === 'GET' && req.path === `/api/resources/${resource}`) {
            normalRead = true;
            return json(200, {
              resource_id: resource,
              current_revision: current,
              revisions: Array.from({ length: current }, (_, i) => i + 1),
            });
          }
          if (req.method === 'POST' && req.path === '/api/renders') {
            const body = object(req.body);
            if (body.resource_id !== resource && !aliases.includes(String(body.resource_id))) {
              unknownRejected = true;
              return json(404, { error: 'resource_missing' });
            }
            const wanted = body.revision ?? current;
            if (
              !Number.isInteger(wanted) ||
              Number(wanted) < 1 ||
              Number(wanted) > current ||
              !profiles.includes(String(body.profile)) ||
              !['thumbnail', 'text'].includes(String(body.format))
            )
              return json(400, { error: 'render_parameters' });
            const id = `V-${++sequence}`;
            jobs.set(id, {
              initial: String(body.resource_id),
              revision: body.profile === pinnedProfile ? Number(wanted) : current,
              format: String(body.format),
              polls: 0,
              profile: String(body.profile),
            });
            return json(202, { render_id: id, status_path: `/api/renders/${id}` });
          }
          const render = /^\/api\/renders\/([^/]+)(\/result)?$/.exec(req.path);
          if (req.method === 'GET' && render) {
            const id = render[1]!;
            const job = jobs.get(id);
            if (!job) return json(404, { error: 'render_missing' });
            if (render[2]) {
              if (job.polls < lag || job.format !== 'text') return json(409, { error: 'text_not_ready' });
              if (job.revision === current) latestObserved = true;
              if (job.initial === target.alias_id && job.revision === target.revision && job.profile === pinnedProfile)
                targetJobs.add(id);
              return json(200, {
                render_id: id,
                initial_resource: job.initial,
                final_resource: resource,
                revision: job.revision,
                checksum: checksums[job.revision - 1],
                text: text(job.revision),
                profile: job.profile,
              });
            }
            job.polls++;
            if (job.polls < lag) return json(202, { render_id: id, state: 'queued' });
            if (job.format === 'thumbnail') {
              thumbnailRead = true;
              return json(200, { render_id: id, state: 'ready', thumbnail: `[edition ${job.revision}]` });
            }
            return json(200, { render_id: id, state: 'ready', result_path: `/api/renders/${id}/result` });
          }
          return noRoute();
        },
        judge(answer) {
          if (
            answer.initial_resource !== target.alias_id ||
            answer.final_resource !== resource ||
            answer.revision !== target.revision ||
            answer.checksum !== checksums[target.revision - 1] ||
            answer.text !== text(target.revision) ||
            answer.profile !== pinnedProfile ||
            !targetJobs.has(String(answer.render_id))
          )
            return '没有取得别名指向的指定修订版渲染结果';
          if (!normalRead || !unknownRejected || !thumbnailRead || !latestObserved)
            return '缺少普通素材、非法编号、缩略图与最新版本的对照';
          return undefined;
        },
      };
    },
  };
}

export function publishFixture(seed: string): ScenarioFixture {
  const rng = new Rng(`publish-version/${seed}`);
  const current = rng.int(3, 5);
  const target = { page_id: `D-${rng.hex(8)}`, revision: rng.int(1, current - 1) };
  const profiles = ['reuse', 'rebuild', 'snapshot', 'compat'];
  const completeProfile = rng.pick(profiles.slice(1));
  const lag = rng.int(2, 4);
  const checksums = Array.from({ length: current }, () => `page-${rng.hex(20)}`);
  return {
    handover: {
      target,
      baseline: {
        method: 'POST',
        path: `/api/pages/${target.page_id}/publish`,
        body: { revision: target.revision, profile: 'reuse' },
      },
    },
    truth: {
      target,
      current,
      checksums,
      completeProfile,
      lag,
      mechanism: '历史版本发布的正文和资源使用不同更新路径，需要同时重建两者',
    },
    open() {
      let publishedRevision = current;
      let assetRevision = current;
      let sequence = 0;
      let normalPublished = false;
      let invalidRejected = false;
      let earlyRejected = false;
      let mismatchObserved = false;
      let finalRead = false;
      const completeJobs = new Set<string>();
      const jobs = new Map<
        string,
        { revision: number; profile: string; polls: number; output?: Record<string, unknown> }
      >();
      const live = () => ({
        page_id: target.page_id,
        revision: publishedRevision,
        asset_revision: assetRevision,
        checksum:
          publishedRevision === assetRevision
            ? checksums[publishedRevision - 1]!
            : `mixed-${publishedRevision}-${assetRevision}`,
      });
      return {
        handle(req) {
          if (req.method === 'GET' && req.path === '/api')
            return json(200, {
              versions: `/api/pages/${target.page_id}/versions`,
              live: `/api/pages/${target.page_id}/live`,
              publish: `/api/pages/${target.page_id}/publish`,
              publish_body: ['revision', 'profile'],
              profiles,
              scheduling: '查询发布作业推进一个周期；正文与资源版本可从 live 核对',
            });
          if (req.method === 'GET' && req.path === `/api/pages/${target.page_id}/versions`)
            return json(200, {
              current_revision: current,
              revisions: Array.from({ length: current }, (_, i) => i + 1),
            });
          if (req.method === 'GET' && req.path === `/api/pages/${target.page_id}/live`) {
            if (publishedRevision !== assetRevision) mismatchObserved = true;
            if (publishedRevision === target.revision && assetRevision === target.revision) finalRead = true;
            return json(200, live());
          }
          if (req.method === 'POST' && req.path === `/api/pages/${target.page_id}/publish`) {
            const body = object(req.body);
            if (!Number.isInteger(body.revision) || Number(body.revision) < 1 || Number(body.revision) > current) {
              invalidRejected = true;
              return json(404, { error: 'revision_missing' });
            }
            if (!profiles.includes(String(body.profile))) return json(400, { error: 'profile_required' });
            const id = `U-${++sequence}`;
            jobs.set(id, { revision: Number(body.revision), profile: String(body.profile), polls: 0 });
            return json(202, {
              publication_id: id,
              status_path: `/api/publications/${id}`,
              result_path: `/api/publications/${id}/result`,
            });
          }
          const match = /^\/api\/publications\/([^/]+)(\/result)?$/.exec(req.path);
          if (req.method === 'GET' && match) {
            const id = match[1]!;
            const job = jobs.get(id);
            if (!job) return json(404, { error: 'publication_missing' });
            if (match[2]) {
              if (!job.output) {
                earlyRejected = true;
                return json(409, { error: 'publication_not_ready' });
              }
              if (job.revision === target.revision && job.profile === completeProfile) completeJobs.add(id);
              return json(200, { publication_id: id, profile: job.profile, ...job.output });
            }
            job.polls++;
            if (job.polls < lag) return json(202, { publication_id: id, state: 'queued' });
            if (!job.output) {
              publishedRevision = job.revision;
              if (job.profile === completeProfile || job.revision === current) assetRevision = job.revision;
              if (job.revision === current) normalPublished = true;
              job.output = live();
            }
            return json(200, { publication_id: id, state: 'ready', result_path: `/api/publications/${id}/result` });
          }
          return noRoute();
        },
        judge(answer) {
          if (
            answer.page_id !== target.page_id ||
            answer.revision !== target.revision ||
            answer.asset_revision !== target.revision ||
            answer.checksum !== checksums[target.revision - 1] ||
            answer.profile !== completeProfile ||
            !completeJobs.has(String(answer.publication_id)) ||
            !finalRead ||
            publishedRevision !== target.revision ||
            assetRevision !== target.revision
          )
            return '历史版本的正文和资源没有一起发布完成';
          if (!normalPublished || !invalidRejected || !earlyRejected || !mismatchObserved)
            return '缺少最新发布、非法版本、未完成作业和混合版本对照';
          return undefined;
        },
      };
    },
  };
}
