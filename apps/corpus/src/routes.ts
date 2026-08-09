import express, { type Response, type Router } from 'express';
import { CorpusEngine } from './engine';
import type { CorpusSearchRequest, ThreadDocument } from './engine/types';

export function createCorpusRouter(engine: CorpusEngine): Router {
  const router = express.Router();

  router.post('/corpus/:did/ingest', (request, response) => {
    handle(response, () => {
      const documents = request.body as ThreadDocument[];
      if (!Array.isArray(documents)) {
        throw new Error('body must be a ThreadDocument[]');
      }

      return engine.ingest(request.params.did, documents);
    });
  });

  router.post('/corpus/:did/search', (request, response) => {
    handle(response, () => engine.search(request.params.did, request.body as CorpusSearchRequest));
  });

  router.post('/corpus/:did/sync', (_request, response) => {
    response.status(501).json({ error: 'sync is not implemented in v1' });
  });

  router.get('/corpus/:did/status', (request, response) => {
    handle(response, () => engine.status(request.params.did));
  });

  router.delete('/corpus/:did/source', (request, response) => {
    handle(response, () => {
      const body = request.body as { source?: string };
      return engine.deleteSource(request.params.did, body.source ?? '');
    });
  });

  router.get('/health', (_request, response) => {
    response.json({ ok: true, service: 'corpus' });
  });

  return router;
}

export function createCorpusApp(engine = new CorpusEngine()): express.Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(createCorpusRouter(engine));
  return app;
}

function handle<T>(response: Response, fn: () => T): void {
  try {
    response.json(fn());
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'request failed' });
  }
}
