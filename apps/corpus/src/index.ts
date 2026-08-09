import { createCorpusApp } from './routes';

const port = Number.parseInt(process.env.PORT ?? '8003', 10);
const app = createCorpusApp();

app.listen(port, () => {
  console.log(`Corpus service listening on :${port}`);
});
