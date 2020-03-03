/** ~*--*~ RUN ME FIRST ~*--*~
 *  Creates the necessary demo spreadsheet in the user's spreadsheets.
 *  Spreadsheet is linked via a trigger to the script.
 */
function createSpreadsheet() {
  var ss = SpreadsheetApp.create(`PassNinja Demo Spreadsheet - ${new Date().toISOString()}`);

  Utilities.sleep(2000);

  ScriptApp.newTrigger('onOpen')
    .forSpreadsheet(ss)
    .onOpen()
    .create();

  buildConfigSheet(ss);
  ss.deleteSheet(ss.getSheetByName('Sheet1'));

  setEnvVar(ENUMS.CURRENT_SPREADSHEET_ID, ss.getId());
  setEnvVar(ENUMS.CURRENT_SPREADSHEET_URL, ss.getUrl());

  // POST CREATION VERIFICATION SETTINGS/LOGS FOLLOW:
  var currentUserEmail = Session.getActiveUser().getEmail();
  var currentSheetOwnerEmail = ss.getOwner().getEmail();

  log(
    log.STATUS,
    ss.getSheets().map(sheet => sheet.getName())
  );
  log(
    log.STATUS,
    `Current user is: ${currentUserEmail} and the new sheet is owned by: ${currentSheetOwnerEmail}`
  );

  setEnvVar('current_user', currentUserEmail);
  setEnvVar('spreadsheet_name', ss.getName());
  setEnvVar('spreadsheet_creator', currentSheetOwnerEmail);
}

/** Custom Trigger: adds the PassNinja script set as a menu item on load.
 *
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('PassNinja')
    .addSubMenu(
      ui
        .createMenu('Selected Row')
        .addItem('Create/Update Pass', 'createPass_')
        .addItem('Force Text passUrl to phoneNumber', 'sendText_')
    )
    .addSeparator()
    .addSubMenu(
      ui
        .createMenu('Setup')
        .addItem('Create/Update Sheets From Config', 'updateFromConfig_')
        .addItem('Set Twilio Credentials', 'storeTwilioDetails_')
        .addItem('Force (Re)Build of Config Sheet', 'buildConfigSheet_')
        .addItem('Force Create/Update Sheets From Config', 'forceUpdateFromConfig_')
    )
    .addToUi();
}

/** Menu command to force update the sheets the config if nothing has changed.
 */
function forceUpdateFromConfig_() {
  updateFromConfig_(true);
}

/** Menu command to force create the config sheet if it needs to be recreated.
 */
function buildConfigSheet_() {
  buildConfigSheet(getLinkedSpreadsheet());
}

/** Menu command to stores the Twilio auth details into the Script Properties permanently..
 * @returns {ServiceError} If setup is cancelled.
 */
function storeTwilioDetails_() {
  var ui = SpreadsheetApp.getUi();

  var questions = [
    ['Enter your Twilio SID:', ENUMS.TWILIO_SID],
    ['Enter your Twilio AUTH:', ENUMS.TWILIO_AUTH],
    ['Enter your Twilio NUMBER:', ENUMS.TWILIO_NUMBER]
  ];
  for ([question, envVar] of questions) {
    var response = ui.prompt(question);
    if (response.getSelectedButton() == ui.Button.OK) {
      setEnvVar(envVar, response.getResponseText());
    } else {
      throw new ScriptError('Cancelling Twilio setup.');
    }
  }
}

/** Menu command to update the Contacts Sheet, Events Sheet and Contacts Form from the Config Sheet
 *
 * @param {Spreadsheet} ss The spreadsheet that contains the conference data.
 * @param {string[]} values Cell values for the spreadsheet range.
 */
function updateFromConfig_(force = false) {
  var ss = getLinkedSpreadsheet();
  var fields = getConfigFields();
  var constants = getConfigConstants();
  var fieldsHash = getEnvVar(ENUMS.FIELDS_HASH, false);
  var hash = MD5(JSON.stringify(fields), true) + MD5(JSON.stringify(constants));
  log(log.STATUS, `Computed hash for fieldsData [new] <-> [old]: ${hash} <-> ${fieldsHash}`);

  if (!force && hash !== fieldsHash) {
    catchError(() => buildEventsSheet(ss), 'Error building Events  Form - ');
    catchError(
      () =>
        buildContactsSheet(
          ss,
          fields.map(f => f[0])
        ),
      'Error building Contacts Sheet - '
    );
    catchError(
      () => buildContactsForm(ss, getSheet(ENUMS.CONTACTS), fields),
      'Error building Contacts Form - '
    );
    setEnvVar(ENUMS.FIELDS_HASH, hash);
  } else {
    Browser.msgBox(
      'No Update',
      "The Config sheet's field data has not changed, not updating.",
      Browser.Buttons.OK
    );
  }
}

/** Custom Trigger: inputs a new user's data from a form submit event and triggers a pass creation.
 *
 * @param {object} e The form event to read from
 * @returns {string} "Lock Timeout" if the contact sheet queries cause a timeout
 */
function onboardNewPassholderFromForm(e) {
  var ss = getLinkedSpreadsheet();
  var sheet = getSheet(ENUMS.CONTACTS);
  var fieldsData = getNamedRange('config_fields', ss)
    .getValues()
    .filter(v => !!v[0]);
  var fieldsNames = fieldsData.map(f => f[0]);

  var lock = LockService.getPublicLock();
  if (lock.tryLock(10000)) {
    sheet.appendRow(fieldsNames.map(field => e.namedValues[field][0]));
    lock.releaseLock();
  } else {
    return 'Lock Timeout';
  }
  autoResizeSheet(sheet);
  sheet.setActiveRange(sheet.getRange(sheet.getLastRow(), 1));
  createPass_();
}

/** Menu command to create a PassNinja pass from the selected row.
 * @returns {string} The response from the PassNinja API.
 * @returns {ServiceError} If the response from PassNinjaService is non 2xx.
 */
function createPass_() {
  var ss = getLinkedSpreadsheet();
  var contactSheet = getSheet(ENUMS.CONTACTS);

  var passNinjaColumnStart = getColumnIndexFromString(contactSheet, ENUMS.PASSURL);
  var serialNumberColumnIndex = getColumnIndexFromString(contactSheet, ENUMS.SERIAL);
  var rowNumber = getValidSheetSelectedRow(contactSheet);

  var rowRange = contactSheet.getRange(rowNumber, 1, 1, passNinjaColumnStart - 1);
  var passNinjaContentRange = contactSheet.getRange(rowNumber, passNinjaColumnStart, 1, 3);
  var passUrlRange = contactSheet.getRange(rowNumber, passNinjaColumnStart, 1, 1);
  var serialNumberRange = contactSheet.getRange(rowNumber, serialNumberColumnIndex, 1, 1);

  var payloadJSONString = getRowPassPayload(ss, rowRange);
  var serial = serialNumberRange.getValue();

  var originalContent = passNinjaContentRange.getValues();
  highlightCells(passNinjaContentRange, 'loading');
  passNinjaContentRange.setValues([['Please wait...', 'pass creation', 'in progress']]);
  SpreadsheetApp.flush();

  try {
    var responseData = serial
      ? new PassNinjaService().updatePass(payloadJSONString, serial)
      : new PassNinjaService().createPass(payloadJSONString);
  } catch (err) {
    passNinjaContentRange.setValues(originalContent);
    highlightCells(passNinjaContentRange, 'error');
    throw err;
  }
  log(log.SUCCESS, JSON.stringify(responseData));
  passNinjaContentRange.setValues([
    [
      responseData.landingUrl,
      responseData.apple.passTypeIdentifier.replace('pass.com.passninja.', ''),
      responseData.apple.serialNumber
    ]
  ]);

  highlightCells(passNinjaContentRange, 'success');
  contactSheet.setActiveSelection(passUrlRange);
  autoResizeSheet(contactSheet);

  if (!serial) sendText_();

  return response.getContentText();
}

/** Sends a text to the current row using the TwilioServce and stored Script Properties.
 *  NOTE: only works if the header 'phoneNumber' is present
 * @returns {ServiceError} If the response from TwilioService is non 2xx.
 * @returns {Error} If an unexpected error occurred running TwilioService.
 */
function sendText_() {
  var twilio;
  try {
    twilio = new TwilioService();
    var contactSheet = getSheet(ENUMS.CONTACTS);
    var passUrl = contactSheet
      .getRange(
        getValidSheetSelectedRow(contactSheet),
        getColumnIndexFromString(contactSheet, ENUMS.PASSURL),
        1,
        1
      )
      .getValue();
    var phoneNumber = contactSheet
      .getRange(
        getValidSheetSelectedRow(contactSheet),
        getColumnIndexFromString(contactSheet, 'phoneNumber'),
        1,
        1
      )
      .getValue();
  } catch (err) {
    if (err instanceof CredentialsError) {
      log(log.ERROR, 'Twilio auth was not set up...ignoring sendText_ attempt.');
      return;
    }
    throw new CredentialsError(
      'CREDENTIALS',
      'You must specify a phoneNumber field in order to use Twilio API capabilities.'
    );
  }

  try {
    twilio.sendText(
      phoneNumber + '',
      `Please click the link to install the requested PassNinja NFC pass: ${passUrl}`
    );
  } catch (err) {
    log(log.ERROR, 'Twilio ran into an unexpected error: ', err);
    throw err;
  }
}

/** Menu command to pop up a modal with the pass events
 *  of the current highlighted row related to the pass via serial number
 *  NOT IMPLEMENTED YET
 */
function showEvents_() {
  var contactSheet = getSheet(ENUMS.CONTACTS);
  var rowNumber = getValidSheetSelectedRow(contactSheet);
  var row = contactSheet.getRange(rowNumber, 1, 1, 12);
  var rowValues = row.getValues();
  var serialNumber = rowRange[0][12];
  var html = '<p>' + serialNumber + '<p>';
  var htmlOutput = HtmlService.createHtmlOutput(html)
    .setWidth(550)
    .setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(htmlOutput, 'Pass Events');
}
