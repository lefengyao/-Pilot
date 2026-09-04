import { FileWorkspace } from './file-workspace.js';

const $ = (id) => document.getElementById(id);
const workspace = new FileWorkspace({
  tree: $('file-tree'), path: $('file-path'), count: $('file-count'), list: $('file-list'), preview: $('file-preview'),
  refresh: $('file-refresh'), upload: $('file-upload'), newFolder: $('file-new-folder'), input: $('file-input'), drop: $('file-drop'), treeToggle: $('file-tree-toggle'),
  dialog: $('file-operation-dialog'), dialogForm: $('file-operation-form'), dialogTitle: $('file-operation-title'), dialogMessage: $('file-operation-message'), dialogLabel: $('file-operation-label'), dialogName: $('file-operation-name'), dialogConfirm: $('file-operation-confirm'), dialogClose: $('file-operation-close'), dialogCancel: $('file-operation-cancel'),
});
$('back-terminal').addEventListener('click', () => { window.location.href = '/'; });
workspace.open();
