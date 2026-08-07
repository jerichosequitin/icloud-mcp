import { MailAdapterError } from './errors';
import type { MailOperation } from './types';

const JSON_HELPERS = `
use framework "Foundation"
use scripting additions

on safeText(valueToRead)
  try
    if valueToRead is missing value then return missing value
    return valueToRead as text
  on error
    return missing value
  end try
end safeText

on jsonValue(valueToEncode)
  if valueToEncode is missing value then
    return current application's NSNull's null()
  end if
  return valueToEncode
end jsonValue

on encodeJson(valueToEncode)
  set jsonData to current application's NSJSONSerialization's dataWithJSONObject:valueToEncode options:0 |error|:(missing value)
  if jsonData is missing value then error number -2700
  return (current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)) as text
end encodeJson

on findAccount(accountId)
  tell application "Mail"
    repeat with accountItem in accounts
      set currentId to my safeText(id of accountItem)
      if currentId is not missing value and currentId is accountId then return accountItem
    end repeat
  end tell
  return missing value
end findAccount

on findMailbox(containerItem, mailboxId)
  tell application "Mail" to set childMailboxes to mailboxes of containerItem
  repeat with mailboxItem in childMailboxes
    tell application "Mail" to set currentId to my safeText(id of mailboxItem)
    if currentId is not missing value and currentId is mailboxId then return mailboxItem
    set nestedMailbox to my findMailbox(mailboxItem, mailboxId)
    if nestedMailbox is not missing value then return nestedMailbox
  end repeat
  return missing value
end findMailbox

on findMessage(mailboxItem, messageId)
  try
    set numericId to messageId as integer
    tell application "Mail" to set matchedMessages to messages of mailboxItem whose id is numericId
    if (count matchedMessages) is greater than 0 then return item 1 of matchedMessages
    return missing value
  on error
    return missing value
  end try
end findMessage
`;

const LIST_FOLDERS_SCRIPT = `${JSON_HELPERS}
on collectFolders(containerItem, accountId, accountName, resultLimit)
  set folderRows to {}
  tell application "Mail" to set childMailboxes to mailboxes of containerItem
  repeat with mailboxItem in childMailboxes
    if (count folderRows) is greater than or equal to resultLimit then exit repeat
    tell application "Mail"
      set mailboxId to my safeText(id of mailboxItem)
      set mailboxName to my safeText(name of mailboxItem)
    end tell
    if mailboxId is not missing value then
      set end of folderRows to {accountId, mailboxId, my jsonValue(mailboxName), my jsonValue(accountName)}
    end if
    set remainingCount to resultLimit - (count folderRows)
    if remainingCount is greater than 0 then
      set nestedRows to my collectFolders(mailboxItem, accountId, accountName, remainingCount)
      set folderRows to folderRows & nestedRows
    end if
  end repeat
  return folderRows
end collectFolders

on run argv
  if (count argv) is not 1 then error number -1708
  set resultLimit to item 1 of argv as integer
  set folderRows to {}
  tell application "Mail"
    repeat with accountItem in accounts
      if (count folderRows) is greater than or equal to resultLimit then exit repeat
      set accountId to my safeText(id of accountItem)
      set accountName to my safeText(name of accountItem)
      if accountId is not missing value then
        set remainingCount to resultLimit - (count folderRows)
        set accountRows to my collectFolders(accountItem, accountId, accountName, remainingCount)
        set folderRows to folderRows & accountRows
      end if
    end repeat
  end tell
  return my encodeJson(folderRows)
end run
`;

const SEARCH_MAIL_SCRIPT = `${JSON_HELPERS}
on recipientMatches(messageItem, queryText)
  tell application "Mail"
    set recipientItems to (every «class trcp» of messageItem) & (every «class crcp» of messageItem) & (every «class brcp» of messageItem)
    repeat with recipientItem in recipientItems
      set recipientAddress to my safeText(address of recipientItem)
      if recipientAddress is not missing value then
        ignoring case
          if recipientAddress contains queryText then return true
        end ignoring
      end if
    end repeat
  end tell
  return false
end recipientMatches

on messageMatches(messageItem, fieldName, queryText)
  if fieldName is "recipient" then return my recipientMatches(messageItem, queryText)
  tell application "Mail"
    if fieldName is "sender" then
      set candidateText to my safeText(sender of messageItem)
    else if fieldName is "subject" then
      set candidateText to my safeText(subject of messageItem)
    else
      error number -1708
    end if
  end tell
  if candidateText is missing value then return false
  ignoring case
    return candidateText contains queryText
  end ignoring
end messageMatches

on run argv
  if (count argv) is not 6 then error number -1708
  set accountId to item 1 of argv
  set mailboxId to item 2 of argv
  set queryText to item 3 of argv
  set fieldName to item 4 of argv
  set scanLimit to item 5 of argv as integer
  set resultLimit to item 6 of argv as integer
  if fieldName is not "recipient" and fieldName is not "sender" and fieldName is not "subject" then error number -1708

  set accountItem to my findAccount(accountId)
  if accountItem is missing value then return my encodeJson({})
  set mailboxItem to my findMailbox(accountItem, mailboxId)
  if mailboxItem is missing value then return my encodeJson({})

  set messageRows to {}
  set scannedCount to 0
  tell application "Mail" to set candidateMessages to messages of mailboxItem
  repeat with messageItem in candidateMessages
    if scannedCount is greater than or equal to scanLimit then exit repeat
    if (count messageRows) is greater than or equal to resultLimit then exit repeat
    set scannedCount to scannedCount + 1
    if my messageMatches(messageItem, fieldName, queryText) then
      tell application "Mail"
        set messageId to my safeText(id of messageItem)
        set messageSubject to my safeText(subject of messageItem)
        set messageSender to my safeText(sender of messageItem)
        set receivedDate to my safeText(date received of messageItem)
      end tell
      if messageId is not missing value then
        set end of messageRows to {accountId, mailboxId, messageId, my jsonValue(messageSubject), my jsonValue(messageSender), my jsonValue(receivedDate)}
      end if
    end if
  end repeat
  return my encodeJson(messageRows)
end run
`;

const GET_MESSAGE_METADATA_SCRIPT = `${JSON_HELPERS}
on recipientAddresses(recipientItems)
  set addresses to {}
  tell application "Mail"
    repeat with recipientItem in recipientItems
      set recipientAddress to my safeText(address of recipientItem)
      if recipientAddress is not missing value then set end of addresses to recipientAddress
    end repeat
  end tell
  return addresses
end recipientAddresses

on metadataRow(accountId, mailboxId, messageId)
  set accountItem to my findAccount(accountId)
  if accountItem is missing value then return {false}
  set mailboxItem to my findMailbox(accountItem, mailboxId)
  if mailboxItem is missing value then return {false}
  set messageItem to my findMessage(mailboxItem, messageId)
  if messageItem is missing value then return {false}

  tell application "Mail"
    set messageSubject to my safeText(subject of messageItem)
    set messageSender to my safeText(sender of messageItem)
    set primaryRecipientItems to every «class trcp» of messageItem
    set carbonCopyItems to every «class crcp» of messageItem
    set blindCopyItems to every «class brcp» of messageItem
    set toAddresses to my recipientAddresses(primaryRecipientItems)
    set ccAddresses to my recipientAddresses(carbonCopyItems)
    set bccAddresses to my recipientAddresses(blindCopyItems)
    set rawInternetMessageId to «class meid» of messageItem
    set rawReceivedDate to «class rdte» of messageItem
    set rawSentDate to «class date» of messageItem
    set internetMessageId to my safeText(rawInternetMessageId)
    set receivedDate to my safeText(rawReceivedDate)
    set sentDate to my safeText(rawSentDate)
    try
      set readState to «class isrd» of messageItem
    on error
      set readState to missing value
    end try
    try
      set flaggedState to «class isfl» of messageItem
    on error
      set flaggedState to missing value
    end try
  end tell

  return {true, my jsonValue(messageSubject), my jsonValue(messageSender), toAddresses, ccAddresses, bccAddresses, my jsonValue(internetMessageId), my jsonValue(receivedDate), my jsonValue(sentDate), my jsonValue(readState), my jsonValue(flaggedState)}
end metadataRow

on run argv
  if (count argv) is 0 or (count argv) mod 3 is not 0 then error number -1708
  set metadataRows to {}
  repeat with argumentIndex from 1 to (count argv) by 3
    set end of metadataRows to my metadataRow(item argumentIndex of argv, item (argumentIndex + 1) of argv, item (argumentIndex + 2) of argv)
  end repeat
  return my encodeJson(metadataRows)
end run
`;

const GET_MESSAGE_BODIES_SCRIPT = `${JSON_HELPERS}
on bodyRow(accountId, mailboxId, messageId, characterLimit)
  set accountItem to my findAccount(accountId)
  if accountItem is missing value then return {false}
  set mailboxItem to my findMailbox(accountItem, mailboxId)
  if mailboxItem is missing value then return {false}
  set messageItem to my findMessage(mailboxItem, messageId)
  if messageItem is missing value then return {false}

  tell application "Mail" to set bodyText to my safeText(content of messageItem)
  if bodyText is missing value then return {true, my jsonValue(missing value), false}
  set wasTruncated to false
  if (length of bodyText) is greater than characterLimit then
    set bodyText to text 1 thru characterLimit of bodyText
    set wasTruncated to true
  end if
  return {true, bodyText, wasTruncated}
end bodyRow

on run argv
  if (count argv) is less than 4 or ((count argv) - 1) mod 3 is not 0 then error number -1708
  set characterLimit to item 1 of argv as integer
  set bodyRows to {}
  repeat with argumentIndex from 2 to (count argv) by 3
    set end of bodyRows to my bodyRow(item argumentIndex of argv, item (argumentIndex + 1) of argv, item (argumentIndex + 2) of argv, characterLimit)
  end repeat
  return my encodeJson(bodyRows)
end run
`;

export function getMailScript(operation: MailOperation): string {
  switch (operation) {
    case 'getMessageBodies':
      return GET_MESSAGE_BODIES_SCRIPT;
    case 'getMessageMetadata':
      return GET_MESSAGE_METADATA_SCRIPT;
    case 'listFolders':
      return LIST_FOLDERS_SCRIPT;
    case 'searchMail':
      return SEARCH_MAIL_SCRIPT;
    default:
      throw new MailAdapterError('UNSUPPORTED_OPERATION');
  }
}
