import routes from '../generated/routes.json';
import { createWorker } from './handler';

export { createWorker };

export default { fetch: createWorker(routes) };
