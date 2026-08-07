import type { FolderAddress, MessageAddress } from '../mail/locators';
import type { ClientAccessPolicy, MailToolName } from './types';

function sameFolder(left: FolderAddress, right: FolderAddress): boolean {
  return (
    left.accountId === right.accountId &&
    left.mailboxPath.length === right.mailboxPath.length &&
    left.mailboxPath.every(
      (segment, index) => segment === right.mailboxPath[index],
    )
  );
}

export function allowsTool(
  client: ClientAccessPolicy,
  tool: MailToolName,
): boolean {
  return client.tools.has(tool);
}

export function allowsFolder(
  client: ClientAccessPolicy,
  address: FolderAddress | MessageAddress,
): boolean {
  return (
    client.mailScope === '*' ||
    client.mailScope.some((entry) => sameFolder(entry.address, address))
  );
}
