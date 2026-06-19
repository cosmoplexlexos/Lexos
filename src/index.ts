import { config } from './config';
import app from './app';

app.listen(config.server.port, () => {
  console.log(`Lexos listening on port ${config.server.port}`);
  if (config.langsmith.enabled) {
    console.log(`LangSmith tracing → project: ${config.langsmith.project}`);
  } else {
    console.log('LangSmith tracing disabled (no LANGSMITH_API_KEY set)');
  }
});

export default app;
