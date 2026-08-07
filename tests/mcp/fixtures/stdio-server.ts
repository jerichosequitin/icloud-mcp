import { startMailStdio } from '../../../src/transports/stdio';
import { FakeMailAdapter } from '../fakes';

startMailStdio({
  adapter: new FakeMailAdapter(),
  diagnostics: () => console.error('Synthetic stdio transport error.'),
});
