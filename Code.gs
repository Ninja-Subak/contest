var SHEET_NAME = "contest";

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Suno 카페 노래 콘테스트')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getAppData(clientToken) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];
  var data = [];
  
  for (var i = 1; i < rows.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = rows[i][j];
    }
    data.push(obj);
  }

  var noticeText = sheet.getRange("G1").getValue();
  var notice = noticeText ? noticeText : "환영합니다! 멋진 곡을 등록하고 투표해 주세요. 😊";

  var hasVoted = false;
  var myVotedId = null;
  
  for (var i = 1; i < rows.length; i++) {
    var votedTokens = String(rows[i][7] || "");
    if (votedTokens.indexOf(clientToken) !== -1) {
      hasVoted = true;
      myVotedId = rows[i][0];
      break;
    }
  }

  return {
    songs: data,
    notice: notice,
    hasVoted: hasVoted,
    myVotedId: myVotedId
  };
}

function saveNotice(newNotice) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  sheet.getRange("G1").setValue(newNotice);
  return "success";
}

function addSong(title, author, url) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var newId = new Date().getTime().toString();
  sheet.appendRow([newId, title, author, url, 0]);
  return "success";
}

function voteSong(id, clientToken) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var rows = sheet.getDataRange().getValues();
  
  for (var i = 1; i < rows.length; i++) {
    var tokens = String(rows[i][7] || "");
    if (tokens.indexOf(clientToken) !== -1) {
      return "already_voted";
    }
  }

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      var currentVotes = Number(rows[i][4]) || 0;
      sheet.getRange(i + 1, 5).setValue(currentVotes + 1);
      
      var existingTokens = String(rows[i][7] || "");
      var newTokens = existingTokens ? existingTokens + "," + clientToken : clientToken;
      sheet.getRange(i + 1, 8).setValue(newTokens);
      break;
    }
  }
  return "success";
}

function updateSong(id, newTitle, newAuthor, newUrl, newVotes) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      sheet.getRange(i + 1, 2).setValue(newTitle);
      sheet.getRange(i + 1, 3).setValue(newAuthor);
      sheet.getRange(i + 1, 4).setValue(newUrl);
      sheet.getRange(i + 1, 5).setValue(newVotes);
      break;
    }
  }
  return "success";
}

function deleteSong(id) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  return "success";
}

function clearContestData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }
  return "success";
}

function getSheetDataForDownload() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var rows = sheet.getDataRange().getValues();
  var exportData = [];
  
  exportData.push(["순번", "노래 제목", "제작자", "수노 링크", "투표수"]);
  
  for (var i = 1; i < rows.length; i++) {
    exportData.push([
      i,
      rows[i][1],
      rows[i][2],
      rows[i][3],
      rows[i][4]
    ]);
  }
  return exportData;
}