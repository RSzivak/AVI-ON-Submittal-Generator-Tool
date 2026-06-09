import React, { useState, useRef, useEffect } from 'react';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import './assets/main.css'; 
import { parseBomForSpecSheets } from './utils/bomParser';
import logoSvg from './assets/logo.svg';

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

const dataURLtoFile = (dataUrl, filename, mimeType) => {
  const arr = dataUrl.split(',');
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) { u8arr[n] = bstr.charCodeAt(n); }
  return new File([u8arr], filename, { type: mimeType });
};

// Storage layer: in Electron, window.electronFS (injected by the preload script)
// gives real filesystem access; in a plain browser we fall back to OPFS.

const isElectron = () => typeof window !== 'undefined' && !!window.electronFS;

const elSaveProject  = (dir, id, data) => window.electronFS.saveProject(dir, id, data);
const elLoadProject  = (dir, id)       => window.electronFS.loadProject(dir, id);
const elDeleteProject= (dir, id)       => window.electronFS.deleteProject(dir, id);
const elPickFolder   = ()              => window.electronFS.pickFolder();
const elDefaultDir   = ()              => window.electronFS.defaultDir();

const opfsAvailable = () => typeof navigator !== 'undefined' && 'storage' in navigator && 'getDirectory' in navigator.storage;

const opfsGetProjectsDir = async () => {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('avion_projects', { create: true });
};

const opfsSaveProject = async (id, data) => {
  const dir = await opfsGetProjectsDir();
  const fileHandle = await dir.getFileHandle(`${id}.json`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data));
  await writable.close();
};

const opfsLoadProject = async (id) => {
  const dir = await opfsGetProjectsDir();
  const fileHandle = await dir.getFileHandle(`${id}.json`);
  const file = await fileHandle.getFile();
  const text = await file.text();
  return JSON.parse(text);
};

const opfsDeleteProject = async (id) => {
  try {
    const dir = await opfsGetProjectsDir();
    await dir.removeEntry(`${id}.json`);
  } catch (e) {}
};

const storageSave = async (saveDir, id, data) => {
  if (isElectron()) return elSaveProject(saveDir, id, data);
  return opfsSaveProject(id, data);
};

const storageLoad = async (saveDir, id) => {
  if (isElectron()) return elLoadProject(saveDir, id);
  return opfsLoadProject(id);
};

const storageDelete = async (saveDir, id) => {
  if (isElectron()) return elDeleteProject(saveDir, id);
  return opfsDeleteProject(id);
};

const INDEX_KEY = 'avion_project_index';
const LEGACY_KEY = 'avion_recent_projects';

const loadProjectIndex = () => {
  try {
    const stored = localStorage.getItem(INDEX_KEY);
    if (stored) return JSON.parse(stored);
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      const index = parsed.map(({ id, name, date }) => ({ id, name, date }));
      localStorage.setItem(INDEX_KEY, JSON.stringify(index));
      return index;
    }
  } catch (e) {}
  return [];
};

const saveProjectIndex = (index) => {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch (e) {}
};

function App() {
  const [view, setView] = useState('start');
  const [page, setPage] = useState('info');
  const [isSaving, setIsSaving] = useState(false);
  const loadFileRef = useRef(null);
  // When the user confirms exit through our in-app modal, flip this to bypass
  // the beforeunload guard on the second close attempt.
  const allowCloseRef = useRef(false);

  const [recentProjects, setRecentProjects] = useState([]);
  const [currentProjectId, setCurrentProjectId] = useState(null);
  const [pendingProject, setPendingProject] = useState(null);
  const [projectToDelete, setProjectToDelete] = useState(null);
  const [isSettingsLoaded, setIsSettingsLoaded] = useState(false);

  const defaultProjectData = {
    projectName: '', projectNumber: '', quoteNumber: '', address: '',
    city: '', state: '', zip: '', submittalDate: new Date().toISOString().split('T')[0], revNumber: '0'
  };

  const defaultChecklist = {
    coverPage: true, tableOfContents: true, approvalWorksheet: false, submittalReview: false, projectNotes: false,
    warranty: false, billOfMaterials: false, startupForm: false, sequenceOfOperations: false, layoutPackage: false,
    riserDiagrams: false, itRequirements: false, startupGuide: false, specSheets: false
  };

  const defaultSectionData = {
    submittalReview: { comments: [], responses: [] }, projectNotes: [], sequenceOfOperations: [],
    billOfMaterials: null, layoutPackage: null, riserDiagrams: null, specSheets: null
  };

  const defaultSettings = {
    coverPagePDF: '', approvalWorksheet: '', warranty: '', startupForm: '',
    itRequirements: '', startupGuide: '', includePageNumbers: true, logoPath: '',
    saveDirectory: '', specSheetDirectory: ''
  };

  const [projectData, setProjectData] = useState(defaultProjectData);
  const [checklist, setChecklist] = useState(defaultChecklist);
  const [sectionData, setSectionData] = useState(defaultSectionData);
  const [settings, setSettings] = useState(defaultSettings);
  const [showModal, setShowModal] = useState(null);
  // Baseline snapshot of the project state as it was last loaded or saved.
  // hasUnsavedData() compares the current values against this to detect real changes,
  // rather than just flagging any non-empty field as unsaved.
  const [baseline, setBaseline] = useState({
    projectData: defaultProjectData,
    checklist: defaultChecklist,
    sectionData: defaultSectionData
  });

  useEffect(() => {
    // Load lightweight project index (id/name/date only — no file data)
    const index = loadProjectIndex();
    setRecentProjects(index);

    // One-time migration: if old avion_recent_projects had full data, move each to OPFS
    if (opfsAvailable() && !isElectron()) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        try {
          const oldRecords = JSON.parse(legacy);
          (async () => {
            for (const record of oldRecords) {
              if (record.data) {
                try { await opfsSaveProject(record.id, record.data); } catch (e) {}
              }
            }
            localStorage.removeItem(LEGACY_KEY);
          })();
        } catch (e) {}
      }
    }

    const storedSettings = localStorage.getItem('avion_global_settings');
    if (storedSettings) {
      try {
        const parsed = JSON.parse(storedSettings);
        const restoredSettings = { ...defaultSettings };
        for (const key of Object.keys(parsed)) {
          const item = parsed[key];
          if (item && item.dataUrl) {
            restoredSettings[key] = dataURLtoFile(item.dataUrl, item.name, item.type);
          } else {
            restoredSettings[key] = item !== undefined ? item : defaultSettings[key];
          }
        }
        // If running in Electron and no saveDirectory saved yet, use the app default
        if (isElectron() && !restoredSettings.saveDirectory) {
          elDefaultDir().then(d => {
            if (d) setSettings(prev => ({ ...prev, saveDirectory: d }));
          }).catch(() => {});
        }
        setSettings(restoredSettings);
      } catch (err) {}
    } else if (isElectron()) {
      // First run in Electron — seed the save directory
      elDefaultDir().then(d => {
        if (d) setSettings(prev => ({ ...prev, saveDirectory: d }));
      }).catch(() => {});
    }
    
    setIsSettingsLoaded(true);
  }, []);

  useEffect(() => {
    if (!isSettingsLoaded) return;
    
    const saveGlobalSettings = async () => {
      const settingsToSave = {};
      for (const key of Object.keys(settings)) {
        if (settings[key] instanceof File) {
          settingsToSave[key] = {
            name: settings[key].name,
            type: settings[key].type,
            dataUrl: await fileToBase64(settings[key])
          };
        } else {
          settingsToSave[key] = settings[key];
        }
      }
      try {
        localStorage.setItem('avion_global_settings', JSON.stringify(settingsToSave));
      } catch (error) {
        console.error("Global Settings Save Error:", error);
      }
    };
    saveGlobalSettings();
  }, [settings, isSettingsLoaded]);

  // Warn the user before closing/refreshing the app if there are unsaved changes.
  // In a normal browser, beforeunload triggers the browser's native dialog.
  // In Electron, beforeunload cancels the close but shows NO dialog — so we
  // intercept it, show our own modal, and re-issue window.close() if the user confirms.
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (allowCloseRef.current) return; // user already confirmed; let it through
      if (hasUnsavedData()) {
        e.preventDefault();
        e.returnValue = '';
        // In Electron, the browser dialog won't show — surface our own modal.
        // (In a plain browser this also runs; the native dialog still appears
        // and the modal lingers harmlessly behind it.)
        if (isElectron()) setShowModal('exitConfirm');
        return '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [projectData, checklist, sectionData, baseline]);

  const handleCreateNew = () => {
    setProjectData(defaultProjectData);
    setChecklist(defaultChecklist);
    setSectionData(defaultSectionData);
    // Preserve global settings (default documents, logo, page numbers, save directory)
    // so they survive across project switches and new project creation.
    // Only reset project-specific overrides, not the user's configured defaults.
    setBaseline({
      projectData: defaultProjectData,
      checklist: defaultChecklist,
      sectionData: defaultSectionData
    });
    setCurrentProjectId(null);
    setView('main');
    setPage('info');
  };

  const handleNewFromSidebar = () => {
    if (hasUnsavedData()) {
      setShowModal('newConfirm');
    } else {
      handleCreateNew();
    }
  };

  const compileSaveData = async () => {
    // Global settings (default documents, logo, page numbers, save directory) are
    // intentionally NOT included in the project file — they live in localStorage
    // under 'avion_global_settings' so they apply across all projects and
    // clearing one in Settings actually sticks.
    const saveData = { projectData, checklist, sectionData: JSON.parse(JSON.stringify(sectionData)) };
    const importKeys = ['billOfMaterials', 'layoutPackage', 'riserDiagrams', 'specSheets'];
    for (const key of importKeys) {
      if (sectionData[key] && sectionData[key].file) {
        if (Array.isArray(sectionData[key].file)) {
          saveData.sectionData[key].file = await Promise.all(
            sectionData[key].file.map(async (f) => ({ name: f.name, type: f.type, dataUrl: await fileToBase64(f) }))
          );
        } else if (sectionData[key].file instanceof File) {
          saveData.sectionData[key].file = { name: sectionData[key].file.name, type: sectionData[key].file.type, dataUrl: await fileToBase64(sectionData[key].file) };
        }
      }
    }
    return saveData;
  };

  const restoreProjectData = (loadedData, projectId = null) => {
    // Intentionally ignore loadedData.settings — global settings are managed
    // entirely through localStorage and the Settings tab, never through project files.
    // (Older project files may still contain a 'settings' block; we just skip it.)

    if (loadedData.sectionData) {
      const importKeys = ['billOfMaterials', 'layoutPackage', 'riserDiagrams', 'specSheets'];
      for (const key of importKeys) {
        if (loadedData.sectionData[key] && loadedData.sectionData[key].file) {
          const item = loadedData.sectionData[key].file;
          if (Array.isArray(item)) {
            loadedData.sectionData[key].file = item.map(i => dataURLtoFile(i.dataUrl, i.name, i.type));
          } else if (item.dataUrl) {
            loadedData.sectionData[key].file = dataURLtoFile(item.dataUrl, item.name, item.type);
          }
        }
      }
      setSectionData(loadedData.sectionData);
    }
    if (loadedData.projectData) setProjectData(loadedData.projectData);
    if (loadedData.checklist) setChecklist(loadedData.checklist);

    // Capture a baseline snapshot so hasUnsavedData() compares against
    // the freshly loaded state rather than reacting to any field having content.
    setBaseline({
      projectData: loadedData.projectData || defaultProjectData,
      checklist: loadedData.checklist || defaultChecklist,
      sectionData: loadedData.sectionData || defaultSectionData
    });

    setCurrentProjectId(projectId);
    setView('main');
    setPage('info');
  };

  const handleLocalSave = async () => {
    setIsSaving(true);
    try {
      const saveData = await compileSaveData();
      const projectId = currentProjectId || Date.now().toString();
      const indexEntry = { id: projectId, name: projectData.projectName || 'Untitled Project', date: new Date().toISOString() };

      await storageSave(settings.saveDirectory, projectId, saveData);

      let index = loadProjectIndex();
      const existingIdx = index.findIndex(p => p.id === projectId);
      if (existingIdx >= 0) index[existingIdx] = indexEntry;
      else index.unshift(indexEntry);
      saveProjectIndex(index);
      setRecentProjects(index);
      setCurrentProjectId(projectId);
      // After a successful save, the current state IS the saved baseline.
      setBaseline({
        projectData: JSON.parse(JSON.stringify(projectData)),
        checklist: JSON.parse(JSON.stringify(checklist)),
        sectionData: sectionData
      });
    } catch (error) {
      console.error("Save Error:", error);
      alert("Save failed. Check the browser console for details.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAndExit = async () => {
    await handleLocalSave();
    allowCloseRef.current = true;
    setShowModal(null);
    window.close();
  };

  const handleExitWithoutSaving = () => {
    allowCloseRef.current = true;
    setShowModal(null);
    window.close();
  };

  const executeDeleteProject = async (id) => {
    await storageDelete(settings.saveDirectory, id);
    const index = loadProjectIndex().filter(p => p.id !== id);
    saveProjectIndex(index);
    setRecentProjects(index);
    if (currentProjectId === id) setCurrentProjectId(null);
    setProjectToDelete(null);
  };

  // Normalize state for change-comparison. File objects can't be JSON.stringified
  // directly, so represent them by a stable signature (name + size + type).
  const normalizeForCompare = (obj) => {
    return JSON.stringify(obj, (key, value) => {
      if (value instanceof File) {
        return { __file: true, name: value.name, size: value.size, type: value.type };
      }
      if (Array.isArray(value) && value.length > 0 && value[0] instanceof File) {
        return value.map(f => ({ __file: true, name: f.name, size: f.size, type: f.type }));
      }
      return value;
    });
  };

  const hasUnsavedData = () => {
    return (
      normalizeForCompare(projectData) !== normalizeForCompare(baseline.projectData) ||
      normalizeForCompare(checklist)    !== normalizeForCompare(baseline.checklist)    ||
      normalizeForCompare(sectionData)  !== normalizeForCompare(baseline.sectionData)
    );
  };

  const executeLoad = async (project) => {
    try {
      const data = await storageLoad(settings.saveDirectory, project.id);
      restoreProjectData(data, project.id);
    } catch (err) {
      console.error("Load Error:", err);
      alert("Could not load project. The file may be missing or corrupted.");
    }
    setPendingProject(null);
    setShowModal(null);
  };

  const handleLoadLocalProject = async (project) => {
    if (project.id === currentProjectId) return; 
    if (hasUnsavedData()) {
      setPendingProject(project);
      setShowModal('saveConfirm');
    } else {
      await executeLoad(project);
    }
  };

  const handleLoadProject = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const loadedData = JSON.parse(e.target.result);
        restoreProjectData(loadedData, null); 
      } catch (err) { alert("Invalid save file."); }
    };
    reader.readAsText(file);
  };

  if (view === 'start') {
    return (
      <div className="start-screen">
        <div className="start-dialog">
          <div className="start-header">
            <h1>AVI-ON Submittal Generator</h1>
            <p>Lighting Controls Submittal Tool</p>
          </div>
          <div className="start-content">
            <button className="btn btn-primary" onClick={handleCreateNew}><span>📄</span> Create New Submittal</button>
            <input type="file" accept=".json" ref={loadFileRef} onChange={handleLoadProject} className="visually-hidden-input" />
            <button className="btn btn-secondary" onClick={() => setShowModal('openProjects')}><span>📂</span> Open Existing Submittal</button>
            <button className="btn btn-secondary" onClick={() => { setView('main'); setPage('settings'); }}><span>⚙️</span> Settings</button>
          </div>
        </div>
        {showModal === 'openProjects' && (
          <OpenProjectsModal
            onClose={() => setShowModal(null)}
            recentProjects={recentProjects}
            onLoad={(p) => { setShowModal(null); handleLoadLocalProject(p); }}
            onDelete={(p) => { setProjectToDelete(p); setShowModal('deleteConfirm'); }}
          />
        )}
        {showModal === 'deleteConfirm' && (
          <DeleteConfirmModal
            onClose={() => { setShowModal(null); setProjectToDelete(null); }}
            projectToDelete={projectToDelete}
            onConfirmDelete={async () => { await executeDeleteProject(projectToDelete?.id); setShowModal('openProjects'); }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="main-app">
      <div className="sidebar">
        <div className="sidebar-header">
          <img src={logoSvg} alt="Company Logo" className="sidebar-logo" />
        </div>
        <div className="sidebar-actions">
          <button className="btn-small btn-secondary" onClick={handleNewFromSidebar}>📄 New</button>
          <button className="btn-small btn-secondary" onClick={() => setShowModal('openProjects')}>📂 Open</button>
        </div>
        <div className="sidebar-body">
          <div className="sidebar-project-label">
            <h3 className="sidebar-project-label__heading">Current Project</h3>
            <div className="sidebar-project-label__name">
              {projectData.projectName || 'New Project'}
            </div>
          </div>
          <div>
            <div className={`nav-item ${page === 'info' ? 'active' : ''}`} onClick={() => setPage('info')}>📋 Project Information</div>
            <div className={`nav-item ${page === 'checklist' ? 'active' : ''}`} onClick={() => setPage('checklist')}>✓ Submittal Checklist</div>
          </div>
          <div className="sidebar-lower">
            <div className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}>⚙️ Settings</div>
            {recentProjects.length > 0 && (
              <div className="sidebar-section sidebar-section--recent">
                <h3 className="sidebar-section__heading">Recent Projects</h3>
                {recentProjects.slice(0, 10).map(p => (
                  <div key={p.id} className={`nav-item nav-item--recent ${currentProjectId === p.id ? 'active' : ''}`} onClick={() => handleLoadLocalProject(p)}>
                    <span className="recent-name">📄 {p.name}</span>
                    <button className="sidebar-delete-btn" onClick={(e) => { e.stopPropagation(); setProjectToDelete(p); setShowModal('deleteConfirm'); }} title="Remove">×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      
      <div className="main-content">
        <input type="file" accept=".json" ref={loadFileRef} onChange={handleLoadProject} className="visually-hidden-input" />
        {page === 'info' && <ProjectInfoPage projectData={projectData} setProjectData={setProjectData} setPage={setPage} onSave={handleLocalSave} isSaving={isSaving} onLoad={handleLoadProject} />}
        {page === 'checklist' && (
          <ChecklistPage 
            checklist={checklist} setChecklist={setChecklist} 
            sectionData={sectionData} setSectionData={setSectionData} 
            setShowModal={setShowModal} settings={settings} setSettings={setSettings}
            onSave={handleLocalSave} isSaving={isSaving}
          />
        )}
        {page === 'settings' && <SettingsPage settings={settings} setSettings={setSettings} />}
      </div>

      {showModal && (
        <ModalManager 
          modalType={showModal} setShowModal={setShowModal} onClose={() => { setShowModal(null); setPendingProject(null); setProjectToDelete(null); }}
          sectionData={sectionData} setSectionData={setSectionData}
          checklist={checklist} setChecklist={setChecklist}
          projectData={projectData} settings={settings}
          pendingProject={pendingProject} projectToDelete={projectToDelete}
          onSaveAndLoad={async () => { await handleLocalSave(); await executeLoad(pendingProject); }}
          onLoadWithoutSaving={async () => await executeLoad(pendingProject)}
          onConfirmDelete={async () => { await executeDeleteProject(projectToDelete?.id); setShowModal(null); }}
          recentProjects={recentProjects}
          onLoadProject={(p) => handleLoadLocalProject(p)}
          onDeleteProject={(p) => { setProjectToDelete(p); setShowModal('deleteConfirm'); }}
          onSaveAndNew={async () => { await handleLocalSave(); setShowModal(null); handleCreateNew(); }}
          onNewWithoutSaving={() => { setShowModal(null); handleCreateNew(); }}
          onSaveAndExit={handleSaveAndExit}
          onExitWithoutSaving={handleExitWithoutSaving}
        />
      )}
    </div>
  );
}

function ProjectInfoPage({ projectData, setProjectData, setPage, onSave, isSaving, onLoad }) {
  const handleChange = (field, value) => setProjectData(prev => ({ ...prev, [field]: value }));

  return (
    <>
      <div className="content-header">
        <div><h1>Project Information</h1><p>Enter the details for your lighting controls submittal</p></div>
        <div className="header-actions">
          <button className="btn-small btn-primary" onClick={onSave} disabled={isSaving}>💾 {isSaving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
      <div className="content-body">
        <div className="form-grid">
          <div className="form-group"><label className="form-label">Project Name *</label><input type="text" className="form-input" value={projectData.projectName} onChange={(e) => handleChange('projectName', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Project Number</label><input type="text" className="form-input" value={projectData.projectNumber} onChange={(e) => handleChange('projectNumber', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Quote Number</label><input type="text" className="form-input" value={projectData.quoteNumber} onChange={(e) => handleChange('quoteNumber', e.target.value)} /></div>
          <div className="form-group form-group--full"><label className="form-label">Project Address</label><input type="text" className="form-input" value={projectData.address} onChange={(e) => handleChange('address', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">City</label><input type="text" className="form-input" value={projectData.city} onChange={(e) => handleChange('city', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">State</label><input type="text" className="form-input" value={projectData.state} onChange={(e) => handleChange('state', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">ZIP Code</label><input type="text" className="form-input" value={projectData.zip} onChange={(e) => handleChange('zip', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Submittal Date</label><input type="date" className="form-input" value={projectData.submittalDate} onChange={(e) => handleChange('submittalDate', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Revision Number</label><input type="text" className="form-input" value={projectData.revNumber} onChange={(e) => handleChange('revNumber', e.target.value)} /></div>
        </div>
        <div className="page-actions--right">
          <button className="btn btn-accent btn--next" onClick={() => setPage('checklist')}>Next: Submittal Checklist <span>→</span></button>
        </div>
      </div>
    </>
  );
}

function ChecklistPage({ checklist, setChecklist, sectionData, setSectionData, setShowModal, settings, setSettings, onSave, isSaving }) {

  const sections = [
    { id: 'coverPage', title: '1. Cover Page', type: 'auto' },
    { id: 'tableOfContents', title: '2. Table of Contents', type: 'auto' },
    { id: 'approvalWorksheet', title: '3. Approval Worksheet', type: 'pdf', settingsKey: 'approvalWorksheet' },
    { id: 'submittalReview', title: '4. Submittal Review Responses', type: 'edit' },
    { id: 'projectNotes', title: '5. Project Notes', type: 'edit' },
    { id: 'warranty', title: '6. Manufacturer Warranty Statement', type: 'pdf', settingsKey: 'warranty' },
    { id: 'billOfMaterials', title: '7. Bill of Materials', type: 'import' },
    { id: 'startupForm', title: '8. System Startup Form', type: 'pdf', settingsKey: 'startupForm' },
    { id: 'sequenceOfOperations', title: '9. Sequence of Operations', type: 'edit' },
    { id: 'layoutPackage', title: '10. Layout Package', type: 'import' },
    { id: 'riserDiagrams', title: '11. System Riser Diagrams', type: 'import' },
    { id: 'itRequirements', title: '12. I.T./Security Requirements', type: 'pdf', settingsKey: 'itRequirements' },
    { id: 'startupGuide', title: '13. Project Startup Guide', type: 'pdf', settingsKey: 'startupGuide' },
    { id: 'specSheets', title: '14. Product Specification Sheets', type: 'import' }
  ];

  const handleClearFile = (e, section) => {
    e.stopPropagation();
    if (section.type === 'import') {
      setSectionData(prev => ({ ...prev, [section.id]: null }));
    } else if (section.type === 'pdf') {
      setSettings(prev => ({ ...prev, [section.settingsKey]: '' }));
    }
    setChecklist(prev => ({ ...prev, [section.id]: false }));
  };

  const getActionButton = (section) => {
    if (section.type === 'edit') return <button className="btn-small btn-edit" onClick={() => setShowModal(section.id)}>EDIT</button>;
    if (section.type === 'import' && section.id !== 'specSheets') return <button className="btn-small btn-import" onClick={() => setShowModal(section.id)}>IMPORT</button>;
    return null;
  };

  const clearBtn = (section) => (
    <button onClick={(e) => handleClearFile(e, section)} title="Remove File" className="inline-icon-btn">
      🗑️
    </button>
  );

  const getStatus = (section) => {
    if (section.type === 'auto') return <span className="section-status">Auto-generated</span>;
    if (section.type === 'pdf' && settings[section.settingsKey]) return <span className="section-status configured section-status--inline">✓ Configured {clearBtn(section)}</span>;
    if (section.type === 'edit') {
      if (section.id === 'submittalReview' && sectionData.submittalReview?.comments?.length > 0) return <span className="section-status configured">✓ {sectionData.submittalReview.comments.length} items</span>;
      if (section.id === 'projectNotes' && sectionData.projectNotes?.length > 0) return <span className="section-status configured">✓ {sectionData.projectNotes.length} notes</span>;
      if (section.id === 'sequenceOfOperations' && sectionData.sequenceOfOperations?.length > 0) return <span className="section-status configured">✓ {sectionData.sequenceOfOperations.length} rows</span>;
    }
    
    // Custom list view specifically for Spec Sheets
    if (section.id === 'specSheets' && sectionData.specSheets) {
      if (sectionData.specSheets.file) {
        const files = Array.isArray(sectionData.specSheets.file) ? sectionData.specSheets.file : [sectionData.specSheets.file];
        return (
          <div className="spec-sheet-list">
            {files.map((f, i) => (
              <span key={i} className="section-status configured section-status--inline">
                ✓ {f.name}
                <button 
                  title="Remove Spec Sheet"
                  className="inline-icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSectionData(prev => {
                      let newFiles = Array.isArray(prev.specSheets.file) ? [...prev.specSheets.file] : [prev.specSheets.file];
                      newFiles.splice(i, 1);
                      if (newFiles.length === 0) {
                        setChecklist(c => ({...c, specSheets: false}));
                        return { ...prev, specSheets: null };
                      }
                      return { ...prev, specSheets: { ...prev.specSheets, file: newFiles, name: `${newFiles.length} files attached` } };
                    });
                  }} 
                >🗑️</button>
              </span>
            ))}
          </div>
        );
      }
      return <span className="section-status configured section-status--inline">✓ {sectionData.specSheets.name} {clearBtn(section)}</span>;
    }

    if (section.type === 'import' && sectionData[section.id]) return <span className="section-status configured section-status--inline">✓ {sectionData[section.id].name} {clearBtn(section)}</span>;
    return <span className="section-status">Not configured</span>;
  };

  return (
    <>
      <div className="content-header">
        <div><h1>Submittal Checklist</h1><p>Select sections to include in your submittal package</p></div>
        <div className="header-actions">
          <button className="btn-small btn-primary" onClick={onSave} disabled={isSaving}>💾 {isSaving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
      <div className="content-body">
        {sections.map(section => (
          <div key={section.id} className={`checklist-section ${checklist[section.id] ? 'checked' : ''}`}>
            <div className="section-header">
              <div className={`custom-checkbox ${checklist[section.id] ? 'checked' : ''}`} onClick={() => setChecklist(prev => ({ ...prev, [section.id]: !prev[section.id] }))}>
                {checklist[section.id] && '✓'}
              </div>
              <div className="section-title">{section.title}</div>
              <div>{getActionButton(section)}</div>
            </div>
            <div className="checklist-status-row">{getStatus(section)}</div>
          </div>
        ))}
        <div className="checklist-generate-row">
          <button className="btn btn-accent btn--generate" onClick={() => setShowModal('generate')}>
            🎯 Generate Submittal
          </button>
        </div>
      </div>
    </>
  );
}

function SettingsPage({ settings, setSettings }) {
  const importFileRef = useRef(null);

  const fileInputRefs = {
    coverPagePDF: useRef(null), approvalWorksheet: useRef(null), warranty: useRef(null),
    startupForm: useRef(null), itRequirements: useRef(null),
    startupGuide: useRef(null), logoPath: useRef(null)
  };

  const handleFileSelect = (key, e) => {
    const file = e.target.files[0];
    if (file) setSettings(prev => ({ ...prev, [key]: file }));
  };

  const handleFileClear = (key) => {
    setSettings(prev => ({ ...prev, [key]: '' }));
    if (fileInputRefs[key] && fileInputRefs[key].current) fileInputRefs[key].current.value = '';
  };

  const pdfSettings = [
    { key: 'coverPagePDF', label: 'Cover Page Template' }, { key: 'approvalWorksheet', label: 'Approval Worksheet' },
    { key: 'warranty', label: 'Manufacturer Warranty Statement' }, { key: 'startupForm', label: 'System Startup Form' },
    { key: 'itRequirements', label: 'I.T./Security Requirements' }, { key: 'startupGuide', label: 'Project Startup Guide' }
  ];

  return (
    <>
      <div className="content-header">
        <div><h1>Settings</h1><p>Configure default documents and preferences</p></div>
      </div>
      <div className="content-body">
        <div className="settings-section">
          <h2>Default PDF Documents</h2>
          {pdfSettings.map(item => (
            <div key={item.key} className="settings-item">
              <div className="settings-item__main">
                <div className="settings-label">{item.label}</div>
                {settings[item.key] ? <div className="file-path">{settings[item.key].name}</div> : <div className="settings-value">No file selected</div>}
              </div>
              <input type="file" ref={fileInputRefs[item.key]} accept=".pdf" onChange={(e) => handleFileSelect(item.key, e)} className="visually-hidden-input" />
              <div className="settings-item__actions">
                {settings[item.key] && <button className="btn-small btn-secondary" onClick={() => handleFileClear(item.key)}>🗑️ Clear</button>}
                <button className="btn-small btn-edit" onClick={() => fileInputRefs[item.key].current?.click()}>📁 Browse</button>
              </div>
            </div>
          ))}
        </div>

        {typeof window !== 'undefined' && window.electronFS && (
          <div className="settings-section">
            <h2>Default Spec Sheet Directory</h2>
            <div className="settings-item">
              <div className="settings-item__main">
                <div className="settings-label">Spec Sheet Location</div>
                <div className="settings-value">Folder the app pulls product spec sheets from</div>
                {settings.specSheetDirectory
                  ? <div className="file-path">{settings.specSheetDirectory}</div>
                  : <div className="settings-value settings-value--warning">No folder selected</div>
                }
              </div>
              <button className="btn-small btn-edit" onClick={async () => {
                const chosen = await window.electronFS.pickFolder();
                if (chosen) setSettings(prev => ({ ...prev, specSheetDirectory: chosen }));
              }}>📁 Browse</button>
            </div>
          </div>
        )}
        
        <div className="settings-section">
          <h2>PDF Output Options</h2>
          <div className="settings-item">
            <div>
              <div className="settings-label">Include Page Numbers</div>
              <div className="settings-value">Add page numbers to PDF output</div>
            </div>
            <div className={`toggle-switch ${settings.includePageNumbers ? 'active' : ''}`} onClick={() => setSettings(prev => ({ ...prev, includePageNumbers: !prev.includePageNumbers }))}>
              <div className="toggle-slider"></div>
            </div>
          </div>

          <div className="settings-item">
            <div className="settings-item__main">
              <div className="settings-label">Company Logo</div>
              <div className="settings-value">Display in upper right corner of each generated page</div>
              {settings.logoPath && <div className="file-path">{settings.logoPath.name}</div>}
            </div>
            <input type="file" ref={fileInputRefs.logoPath} accept="image/*" onChange={(e) => handleFileSelect('logoPath', e)} className="visually-hidden-input" />
            <div className="settings-item__actions">
              {settings.logoPath && (
                <button className="btn-small btn-secondary" onClick={() => handleFileClear('logoPath')}>
                  🗑️ Clear
                </button>
              )}
              <button className="btn-small btn-edit" onClick={() => fileInputRefs.logoPath.current?.click()}>
                🖼️ Browse
              </button>
            </div>
          </div>
        </div>

        {typeof window !== 'undefined' && window.electronFS && (
          <div className="settings-section">
            <h2>Project Storage</h2>
            <div className="settings-item">
              <div className="settings-item__main">
                <div className="settings-label">Save Location</div>
                <div className="settings-value">Folder where project files are saved as JSON</div>
                {settings.saveDirectory
                  ? <div className="file-path">{settings.saveDirectory}</div>
                  : <div className="settings-value settings-value--warning">No folder selected</div>
                }
              </div>
              <button className="btn-small btn-edit" onClick={async () => {
                const chosen = await window.electronFS.pickFolder();
                if (chosen) setSettings(prev => ({ ...prev, saveDirectory: chosen }));
              }}>📁 Browse</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function OpenProjectsModal({ onClose, recentProjects, onLoad, onDelete }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--narrow" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Open Project</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {recentProjects.length === 0 ? (
            <p className="project-list__empty">No saved projects found.</p>
          ) : (
            <div className="project-list">
              {recentProjects.map(p => (
                <div key={p.id} className="project-list__item"
                  onClick={() => { onLoad(p); onClose(); }}>
                  <div>
                    <div className="project-list__name">📄 {p.name}</div>
                    <div className="project-list__date">{new Date(p.date).toLocaleDateString()}</div>
                  </div>
                  <button className="sidebar-delete-btn project-list__delete"
                    onClick={e => { e.stopPropagation(); onDelete(p); }}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ModalManager({ 
  modalType, setShowModal, onClose, sectionData, setSectionData, checklist, 
  setChecklist, projectData, settings, pendingProject, projectToDelete, onSaveAndLoad, onLoadWithoutSaving, onConfirmDelete,
  recentProjects, onLoadProject, onDeleteProject, onSaveAndNew, onNewWithoutSaving,
  onSaveAndExit, onExitWithoutSaving
}) {
  if (modalType === 'openProjects') return <OpenProjectsModal onClose={onClose} recentProjects={recentProjects} onLoad={onLoadProject} onDelete={p => { onDeleteProject(p); }} />;
  if (modalType === 'saveConfirm') return <SaveConfirmModal onClose={onClose} pendingProject={pendingProject} onSaveAndLoad={onSaveAndLoad} onLoadWithoutSaving={onLoadWithoutSaving} />;
  if (modalType === 'newConfirm') return <NewConfirmModal onClose={onClose} onSaveAndNew={onSaveAndNew} onNewWithoutSaving={onNewWithoutSaving} />;
  if (modalType === 'exitConfirm') return <ExitConfirmModal onClose={onClose} onSaveAndExit={onSaveAndExit} onExitWithoutSaving={onExitWithoutSaving} />;
  if (modalType === 'deleteConfirm') return <DeleteConfirmModal onClose={onClose} projectToDelete={projectToDelete} onConfirmDelete={onConfirmDelete} />;
  if (modalType === 'submittalReview') return <SubmittalReviewModal onClose={onClose} sectionData={sectionData} setSectionData={setSectionData} />;
  if (modalType === 'projectNotes') return <ProjectNotesModal onClose={onClose} sectionData={sectionData} setSectionData={setSectionData} />;
  if (modalType === 'sequenceOfOperations') return <SequenceOfOperationsModal onClose={onClose} sectionData={sectionData} setSectionData={setSectionData} />;
  
  if (['billOfMaterials', 'layoutPackage', 'riserDiagrams', 'specSheets'].includes(modalType)) 
    return <FileImportModal modalType={modalType} onClose={onClose} setShowModal={setShowModal} sectionData={sectionData} setSectionData={setSectionData} />;
  
  if (modalType === 'autoParseConfirm')
    return <AutoParseConfirmModal onClose={onClose} sectionData={sectionData} setSectionData={setSectionData} setChecklist={setChecklist} settings={settings} />;

  if (modalType === 'generate') 
    return <GenerateModal onClose={onClose} checklist={checklist} setChecklist={setChecklist} projectData={projectData} sectionData={sectionData} settings={settings} />;
  
  return null;
}

function AutoParseConfirmModal({ onClose, sectionData, setSectionData, setChecklist, settings }) {
  const [isParsing, setIsParsing] = useState(false);

  const handleYes = async () => {
    setIsParsing(true);
    try {
      const matchedFilenames = await parseBomForSpecSheets(sectionData.billOfMaterials.file);

      if (matchedFilenames.length === 0) {
        alert("BOM parser finished, but found no matching part numbers.");
        onClose();
        return;
      }

      const files = [];
      // If a default spec sheet directory has been configured in Settings, read the
      // files from there through the Electron filesystem bridge; otherwise fall back
      // to the app's bundled ./spec-sheets/ folder served alongside the renderer.
      const configuredDir = (settings?.specSheetDirectory || '').trim();
      const useConfiguredDir = !!configuredDir
        && isElectron()
        && typeof window.electronFS.readSpecSheet === 'function';

      const loadSpecSheetFile = async (name) => {
        if (useConfiguredDir) {
          const bytes = await window.electronFS.readSpecSheet(configuredDir, name);
          return new File([bytes], name, { type: 'application/pdf' });
        }
        const res = await fetch(`./spec-sheets/${name}`);
        if (!res.ok) throw new Error(`Failed to fetch ${name}`);
        const blob = await res.blob();
        return new File([blob], name, { type: 'application/pdf' });
      };

      for (const name of matchedFilenames) {
        try {
          files.push(await loadSpecSheetFile(name));
        } catch (err) {
          console.error(`Failed to load auto spec sheet ${name}:`, err);
        }
      }

      if (files.length > 0) {
        setSectionData(prev => ({
          ...prev,
          specSheets: {
            name: `${files.length} Auto-compiled Spec Sheets`,
            path: 'Parsed from BOM',
            source: 'auto',
            file: files
          }
        }));
        setChecklist(prev => ({ ...prev, specSheets: true }));
      } else {
        alert("Matched part numbers, but could not load the PDF files from the local directory.");
      }
    } catch (error) {
      console.error(error);
      alert("An error occurred while parsing the BOM.");
    } finally {
      setIsParsing(false);
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={!isParsing ? onClose : undefined}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Auto-Compile Spec Sheets?</h2>
          {!isParsing && <button className="close-btn" onClick={onClose}>×</button>}
        </div>
        <div className="modal-body">
          {isParsing ? (
            <div className="parse-status">
              <p className="parse-status__title">⏳ Parsing Bill of Materials...</p>
              <p className="parse-status__detail">Looking for matching part numbers.</p>
            </div>
          ) : (
            <p className="parse-prompt">
              Would you like to automatically scan this Bill of Materials and attach the corresponding Product Specification Sheets to your submittal?
            </p>
          )}
        </div>
        {!isParsing && (
          <div className="modal-footer modal-footer--end">
            <button className="btn btn-secondary" onClick={onClose}>No, skip</button>
            <button className="btn btn-primary" onClick={handleYes}>Yes, auto-compile</button>
          </div>
        )}
      </div>
    </div>
  );
}

function SaveConfirmModal({ onClose, pendingProject, onSaveAndLoad, onLoadWithoutSaving }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Unsaved Workspace</h2><button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p>It looks like you have data entered. Save your work before opening <strong>{pendingProject?.name || 'the selected project'}</strong>?</p>
        </div>
        <div className="modal-footer modal-footer--split">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <div className="btn-group">
            <button className="btn btn-secondary" onClick={onLoadWithoutSaving}>Don't Save</button>
            <button className="btn btn-primary" onClick={onSaveAndLoad}>Save & Open</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NewConfirmModal({ onClose, onSaveAndNew, onNewWithoutSaving }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Unsaved Workspace</h2><button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p>You have unsaved data. Would you like to save before creating a new submittal?</p>
        </div>
        <div className="modal-footer modal-footer--split">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <div className="btn-group">
            <button className="btn btn-secondary" onClick={onNewWithoutSaving}>Don't Save</button>
            <button className="btn btn-primary" onClick={onSaveAndNew}>Save & New</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExitConfirmModal({ onClose, onSaveAndExit, onExitWithoutSaving }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Unsaved Workspace</h2><button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p>You have unsaved changes. Save your work before exiting?</p>
        </div>
        <div className="modal-footer modal-footer--split">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <div className="btn-group">
            <button className="btn btn-secondary" onClick={onExitWithoutSaving}>Don't Save</button>
            <button className="btn btn-primary" onClick={onSaveAndExit}>Save & Exit</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmModal({ onClose, projectToDelete, onConfirmDelete }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header"><h2>Confirm Deletion</h2><button className="close-btn" onClick={onClose}>×</button></div>
        <div className="modal-body"><p>Permanently delete <strong>{projectToDelete?.name || 'this project'}</strong>?</p></div>
        <div className="modal-footer modal-footer--end">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn--danger" onClick={onConfirmDelete}>🗑 Permanent Delete</button>
        </div>
      </div>
    </div>
  );
}

function FileImportModal({ modalType, onClose, setShowModal, sectionData, setSectionData }) {
  const [source, setSource] = useState('local');
  const [fileName, setFileName] = useState('');
  const [filePath, setFilePath] = useState('');
  const [selectedFile, setSelectedFile] = useState(null); 
  const fileInputRef = useRef(null);

  const titles = { billOfMaterials: 'Bill of Materials', layoutPackage: 'Layout Package', riserDiagrams: 'System Riser Diagrams', specSheets: 'Product Specification Sheets' };

  const handleLocalFile = (e) => { 
    if (modalType === 'specSheets' && e.target.files.length > 1) {
      const files = Array.from(e.target.files);
      setFileName(`${files.length} files selected`); setFilePath('Multiple files attached'); setSelectedFile(files);
    } else {
      const file = e.target.files[0]; 
      if (file) { setFileName(file.name); setFilePath(file.name); setSelectedFile(file); } 
    }
  };

  const handleSharePoint = () => { const url = prompt('Enter SharePoint URL:'); if (url) { setFileName(url.split('/').pop()); setFilePath(url); setSelectedFile(null); } };
  const handleNetwork = () => { const path = prompt('Enter network path (e.g., \\\\server\\share\\file.pdf):'); if (path) { setFileName(path.split('\\').pop()); setFilePath(path); setSelectedFile(null); } };

  const handleSave = () => {
    if (!fileName) return alert('Please select a file first');
    setSectionData(prev => ({ ...prev, [modalType]: { name: fileName, path: filePath, source, file: selectedFile } }));
    
    if (modalType === 'billOfMaterials' && selectedFile instanceof File) {
      setShowModal('autoParseConfirm');
    } else {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header"><h2>Import {titles[modalType]}</h2><button className="close-btn" onClick={onClose}>×</button></div>
        <div className="modal-body">
          <div className="file-picker-option" onClick={() => setSource('local')}>
            <input type="radio" checked={source === 'local'} onChange={() => {}} />
            <div><strong>💻 Local Computer</strong><div className="file-picker-option__detail">Browse files on this computer</div></div>
          </div>
          <div className="file-picker-option" onClick={() => setSource('sharepoint')}>
            <input type="radio" checked={source === 'sharepoint'} onChange={() => {}} />
            <div><strong>☁️ SharePoint / OneDrive</strong><div className="file-picker-option__detail">Enter SharePoint URL</div></div>
          </div>
          <div className="file-picker-option" onClick={() => setSource('network')}>
            <input type="radio" checked={source === 'network'} onChange={() => {}} />
            <div><strong>🌐 Network Drive</strong><div className="file-picker-option__detail">Enter UNC path</div></div>
          </div>

          <div className="file-picker-actions">
            {source === 'local' && (
              <>
                <input type="file" ref={fileInputRef} accept=".pdf" multiple={modalType === 'specSheets'} onChange={handleLocalFile} className="visually-hidden-input" />
                <button className="btn btn-primary btn-block" onClick={() => fileInputRef.current?.click()}>📁 Browse Local Files</button>
              </>
            )}
            {source === 'sharepoint' && <button className="btn btn-primary btn-block" onClick={handleSharePoint}>☁️ Enter SharePoint URL</button>}
            {source === 'network' && <button className="btn btn-primary btn-block" onClick={handleNetwork}>🌐 Enter Network Path</button>}
          </div>
          {fileName && (
            <div className="selected-file-box">
              <strong>Selected File:</strong><div className="file-path">{fileName}</div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Import File</button>
        </div>
      </div>
    </div>
  );
}

function SubmittalReviewModal({ onClose, sectionData, setSectionData }) {
  const [comments, setComments] = useState(sectionData.submittalReview?.comments || ['']);
  const [responses, setResponses] = useState(sectionData.submittalReview?.responses || ['']);

  const handleSave = () => { setSectionData(prev => ({ ...prev, submittalReview: { comments, responses } })); onClose(); };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header"><h2>Submittal Review Responses</h2><button className="close-btn" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {comments.map((comment, idx) => (
            <div key={idx} className="comment-pair">
              <div className="form-group"><label className="form-label">Comment #{idx + 1}</label><textarea className="form-textarea" value={comment} onChange={(e) => { const c = [...comments]; c[idx] = e.target.value; setComments(c); }} /></div>
              <div className="form-group form-group--spaced"><label className="form-label">Response #{idx + 1}</label><textarea className="form-textarea" value={responses[idx] || ''} onChange={(e) => { const r = [...responses]; r[idx] = e.target.value; setResponses(r); }} /></div>
            </div>
          ))}
          <button className="btn btn-secondary btn-block" onClick={() => { setComments([...comments, '']); setResponses([...responses, '']); }}>+ Add Comment/Response Pair</button>
        </div>
        <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={handleSave}>Save</button></div>
      </div>
    </div>
  );
}

function ProjectNotesModal({ onClose, sectionData, setSectionData }) {
  const [notes, setNotes] = useState(sectionData.projectNotes?.length > 0 ? sectionData.projectNotes : ['']);
  const handleSave = () => { setSectionData(prev => ({ ...prev, projectNotes: notes.filter(n => n.trim() !== '') })); onClose(); };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header"><h2>Project Notes</h2><button className="close-btn" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {notes.map((note, idx) => (
            <div key={idx} className="note-item">
              <div className="note-number">{idx + 1}</div>
              <div className="note-content"><textarea className="form-textarea" value={note} onChange={(e) => { const n = [...notes]; n[idx] = e.target.value; setNotes(n); }} /></div>
            </div>
          ))}
          <button className="btn btn-secondary btn--add-note" onClick={() => setNotes([...notes, ''])}>+ Add Note</button>
        </div>
        <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={handleSave}>Save Notes</button></div>
      </div>
    </div>
  );
}

function SequenceOfOperationsModal({ onClose, sectionData, setSectionData }) {
  const emptyRow = () => ({
    label: '', roomType: '', vacancyMode: false, occupancyMode: false, sensorTimeout: '',
    dualTech: false, scheduleOn: false, scheduleOff: false, scheduleOverride: false,
    manualOnOff: false, manualDimming: false, keySwitch: false, sceneControl: false,
    graphicTouch: false, dlSwitching: false, dlDimming: false, targetLighting: '',
    exteriorLocation: false, plugLoad: false, networked: false, notes: '', narrative: ''
  });

  const [rows, setRows] = useState(
    sectionData.sequenceOfOperations?.length > 0 ? sectionData.sequenceOfOperations : [emptyRow()]
  );

  const updateField = (index, field, value) => { const r = [...rows]; r[index][field] = value; setRows(r); };
  const handleSave = () => { setSectionData(prev => ({ ...prev, sequenceOfOperations: rows })); onClose(); };

  // Columns in printed-SOO order. Per-column widths (minW/inputW) stay data-driven
  // because each column sizes to its own content; table uses auto layout in the modal.
  const modalCols = [
    { k: 'label',            label: 'Label',               type: 'text',     minW: '44px',  inputW: '40px'  },
    { k: 'roomType',         label: 'Room Type',            type: 'text',     minW: '90px',  inputW: '86px'  },
    { k: 'vacancyMode',      label: 'Vacancy Mode',         type: 'bool',     minW: null,    inputW: null    },
    { k: 'occupancyMode',    label: 'Occupancy Mode',       type: 'bool',     minW: null,    inputW: null    },
    { k: 'sensorTimeout',    label: 'Sensor Timeout',       type: 'number',   minW: null,    inputW: '48px'  },
    { k: 'dualTech',         label: 'Dual Technology',      type: 'bool',     minW: null,    inputW: null    },
    { k: 'scheduleOn',       label: 'Schedule On',          type: 'bool',     minW: null,    inputW: null    },
    { k: 'scheduleOff',      label: 'Schedule Off',         type: 'bool',     minW: null,    inputW: null    },
    { k: 'scheduleOverride', label: 'Schedule Override',    type: 'bool',     minW: null,    inputW: null    },
    { k: 'manualOnOff',      label: 'Manual On/Off',        type: 'bool',     minW: null,    inputW: null    },
    { k: 'manualDimming',    label: 'Manual Dimming',       type: 'bool',     minW: null,    inputW: null    },
    { k: 'keySwitch',        label: 'Key Switch',           type: 'bool',     minW: null,    inputW: null    },
    { k: 'sceneControl',     label: 'Scene Control',        type: 'bool',     minW: null,    inputW: null    },
    { k: 'graphicTouch',     label: 'Graphic Touchscreen',  type: 'bool',     minW: null,    inputW: null    },
    { k: 'dlSwitching',      label: 'DL Switching',         type: 'bool',     minW: null,    inputW: null    },
    { k: 'dlDimming',        label: 'DL Dimming',           type: 'bool',     minW: null,    inputW: null    },
    { k: 'targetLighting',   label: 'Target Lighting',      type: 'text',     minW: null,    inputW: '56px'  },
    { k: 'exteriorLocation', label: 'Exterior Location',    type: 'bool',     minW: null,    inputW: null    },
    { k: 'plugLoad',         label: 'Plug Load Control',    type: 'bool',     minW: null,    inputW: null    },
    { k: 'networked',        label: 'Networked',            type: 'bool',     minW: null,    inputW: null    },
    { k: 'notes',            label: 'Notes',                type: 'text',     minW: '70px',  inputW: '66px'  },
    { k: 'narrative',        label: 'Narrative',            type: 'textarea', minW: '180px', inputW: '174px' },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--full" onClick={e => e.stopPropagation()}>
        <div className="modal-header"><h2>Sequence of Operations Matrix</h2><button className="close-btn" onClick={onClose}>x</button></div>
        <div className="modal-body">
          <div className="soo-scroll">
            <table className="soo-table soo-table--matrix">
              <thead>
                <tr>
                  {modalCols.map(col => (
                    <th key={col.k} style={col.minW ? { minWidth: col.minW } : undefined}>{col.label}</th>
                  ))}
                  <th className="soo-col--remove"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={idx}>
                    {modalCols.map(col => {
                      if (col.type === 'bool') return (
                        <td key={col.k} className="soo-cell--bool"
                          onClick={() => updateField(idx, col.k, !row[col.k])}>
                          {row[col.k] ? '●' : <span className="soo-dot--off">○</span>}
                        </td>
                      );
                      if (col.type === 'textarea') return (
                        <td key={col.k} className="soo-cell--textarea">
                          <textarea value={row[col.k]} onChange={(e) => updateField(idx, col.k, e.target.value)}
                            className="soo-input--textarea" style={{ width: col.inputW }} />
                        </td>
                      );
                      const isLeft = col.k === 'notes' || col.k === 'roomType';
                      return (
                        <td key={col.k} className={isLeft ? 'soo-cell--left' : 'soo-cell--center'}>
                          <input type={col.type} value={row[col.k]} onChange={(e) => updateField(idx, col.k, e.target.value)}
                            className={isLeft ? 'soo-cell--left' : 'soo-cell--center'} style={{ width: col.inputW }} />
                        </td>
                      );
                    })}
                    <td className="soo-cell--center">
                      <button className="icon-btn" onClick={() => setRows(rows.filter((_, i) => i !== idx))}>x</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn btn-secondary btn--add-row" onClick={() => setRows([...rows, emptyRow()])}>+ Add Row</button>
        </div>
        <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={handleSave}>Save Matrix</button></div>
      </div>
    </div>
  );
}

function GenerateModal({ onClose, checklist, setChecklist, projectData, sectionData, settings }) {
  const [localChecklist, setLocalChecklist] = useState({ ...checklist });
  const [isGenerating, setIsGenerating] = useState(false);

  const PAGE_WIDTH = 612; const PAGE_HEIGHT = 792;

  const sections = [
    { id: 'coverPage', title: '1. Cover Page', type: 'auto' }, { id: 'tableOfContents', title: '2. Table of Contents', type: 'auto' },
    { id: 'approvalWorksheet', title: '3. Approval Worksheet', type: 'pdf', settingsKey: 'approvalWorksheet' }, { id: 'submittalReview', title: '4. Submittal Review Responses', type: 'edit' },
    { id: 'projectNotes', title: '5. Project Notes', type: 'edit' }, { id: 'warranty', title: '6. Manufacturer Warranty Statement', type: 'pdf', settingsKey: 'warranty' },
    { id: 'billOfMaterials', title: '7. Bill of Materials', type: 'import' }, { id: 'startupForm', title: '8. System Startup Form', type: 'pdf', settingsKey: 'startupForm' },
    { id: 'sequenceOfOperations', title: '9. Sequence of Operations', type: 'edit' }, { id: 'layoutPackage', title: '10. Layout Package', type: 'import' },
    { id: 'riserDiagrams', title: '11. System Riser Diagrams', type: 'import' }, { id: 'itRequirements', title: '12. I.T./Security Requirements', type: 'pdf', settingsKey: 'itRequirements' },
    { id: 'startupGuide', title: '13. Project Startup Guide', type: 'pdf', settingsKey: 'startupGuide' },
    { id: 'specSheets', title: '14. Product Specification Sheets', type: 'import' }
  ];

  const allSelected = sections.every(section => localChecklist[section.id]);
  
  const handleToggleAll = () => {
    const newChecklist = {};
    sections.forEach(section => {
      newChecklist[section.id] = !allSelected;
    });
    setLocalChecklist(newChecklist);
  };

  const imageToPngBytes = (file) => {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.crossOrigin = "Anonymous";
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = 3; 
        const w = img.width || 300;
        const h = img.height || 150;
        
        canvas.width = w * scale;
        canvas.height = h * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        canvas.toBlob(async (blob) => {
          if (blob) {
            const arrayBuffer = await blob.arrayBuffer();
            resolve(arrayBuffer);
          } else {
            reject(new Error("Canvas to Blob failed"));
          }
          URL.revokeObjectURL(url);
        }, 'image/png');
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Failed to load image for conversion"));
      };
      img.src = url;
    });
  };

  const handleGenerate = async () => {
    setIsGenerating(true);

    const wrapText = (text, maxWidth, textFont, fontSize) => {
      // Split on spaces, then split each word after any - or / keeping the separator
      // attached to the left part, so "On/Off" → ["On/", "Off"]
      const rawWords = (text || '').toString().split(' ');
      const tokens = [];
      for (const word of rawWords) {
        const parts = word.split(/(?<=[\/\-])/);
        for (const part of parts) if (part) tokens.push(part);
      }
      let lines = [];
      let currentLine = '';
      for (const token of tokens) {
        const needsSpace = currentLine && !currentLine.match(/[\/\-]$/);
        const candidate = currentLine
          ? (needsSpace ? `${currentLine} ${token}` : `${currentLine}${token}`)
          : token;
        if (textFont.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
          currentLine = candidate;
        } else {
          if (currentLine) lines.push(currentLine);
          currentLine = token;
        }
      }
      if (currentLine) lines.push(currentLine);
      return lines;
    };

    try {
      const pdfDoc = await PDFDocument.create();
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontTimesRegular = await pdfDoc.embedFont(StandardFonts.TimesRoman);
      const fontTimesBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
      const fontTimesBoldItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic);
      const tocEntries = []; 
      let tocPage = null; 
      
      // Specifically track which pages WE dynamically generated to receive the logo
      const pagesForLogo = [];

      for (const section of sections) {
        if (!localChecklist[section.id]) continue;
        const startPageNum = pdfDoc.getPageCount() + 1;
        
        // Strip out the leading number and period from the section title for PDF generation
        const cleanTitle = section.title.replace(/^\d+\.\s*/, '');

        if (section.id !== 'coverPage' && section.id !== 'tableOfContents') {
          tocEntries.push({ title: cleanTitle, pageNum: startPageNum });
        }

        let attachedFile = null;

        if (section.type === 'pdf' && settings?.[section.settingsKey] instanceof File) {
          attachedFile = settings[section.settingsKey];
        } else if (section.type === 'import' && sectionData?.[section.id]?.file) {
          attachedFile = sectionData[section.id].file;
        }

        if (attachedFile) {
          try {
            const filesToMerge = Array.isArray(attachedFile) ? attachedFile : [attachedFile];
            for (const file of filesToMerge) {
              if (file instanceof File) {
                const loadedPdf = await PDFDocument.load(await file.arrayBuffer());
                const copiedPages = await pdfDoc.copyPages(loadedPdf, loadedPdf.getPageIndices());
                copiedPages.forEach(p => pdfDoc.addPage(p));
              }
            }
            continue; 
          } catch (err) {
            console.error("Failed to merge file(s)", err);
          }
        }

        // Initialize a new dynamically drawn page
        // sequenceOfOperations creates its own landscape page inside its block
        let page = section.id !== 'sequenceOfOperations' ? pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]) : null;
        let currentY = section.id !== 'sequenceOfOperations' ? PAGE_HEIGHT - 100 : 0;
        // Note: sequenceOfOperations intentionally leaves page=null here and creates its own landscape page below

        // Apply Logo to all generated pages EXCEPT the cover page
        if (section.id !== 'coverPage' && section.id !== 'sequenceOfOperations') {
          pagesForLogo.push(page);
        }
        
        if (section.id !== 'sequenceOfOperations') {
          page.drawText(cleanTitle, { x: 40, y: PAGE_HEIGHT - 60, size: 20, font: fontBold, color: rgb(0, 0.2, 0.5) });
        }

        // Helper function that dynamically breaks lines and creates new pages if text overflows
        const drawWrappedText = (text, maxWidth, textFont, fontSize, x, color = rgb(0, 0, 0)) => {
          const lines = wrapText(text, maxWidth, textFont, fontSize);
          for (const line of lines) {
            if (currentY < 50) {
              page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
              if (section.id !== 'coverPage') pagesForLogo.push(page); // Track continuation pages
              currentY = PAGE_HEIGHT - 50;
            }
            page.drawText(line, { x, y: currentY, size: fontSize, font: textFont, color });
            currentY -= (fontSize + 6);
          }
        };

        if (section.id === 'tableOfContents') { tocPage = page; continue; }

        if (section.id === 'coverPage') {
          // Remove the generic section title drawn above — cover page has its own header
          // (title was already drawn at PAGE_HEIGHT - 60; we overdraw with white to clear it)
          page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 80, width: PAGE_WIDTH, height: 80, color: rgb(1, 1, 1) });

          // ── LOGO (centered, upper area ~y 609–716 in template coords) ──────────
          let coverLogoImage = null;
          let coverLogoDims = null;
          if (settings.logoPath instanceof File) {
            try {
              const fileType = settings.logoPath.type.toLowerCase();
              let logoBytes;
              if (fileType === 'image/jpeg' || fileType === 'image/jpg') {
                logoBytes = await settings.logoPath.arrayBuffer();
                coverLogoImage = await pdfDoc.embedJpg(logoBytes);
              } else if (fileType === 'image/png') {
                logoBytes = await settings.logoPath.arrayBuffer();
                coverLogoImage = await pdfDoc.embedPng(logoBytes);
              } else {
                logoBytes = await imageToPngBytes(settings.logoPath);
                coverLogoImage = await pdfDoc.embedPng(logoBytes);
              }
              if (coverLogoImage) coverLogoDims = coverLogoImage.scaleToFit(230, 107);
            } catch (imgErr) { console.error("Cover logo error", imgErr); }
          }

          if (coverLogoImage && coverLogoDims) {
            const logoX = (PAGE_WIDTH - coverLogoDims.width) / 2;
            const logoY = 609; // matches template rect bottom y
            page.drawImage(coverLogoImage, { x: logoX, y: logoY, width: coverLogoDims.width, height: coverLogoDims.height });
          }

          // Helper: draw centered text on the cover page
          const drawCentered = (text, y, size, font, options = {}) => {
            const textWidth = font.widthOfTextAtSize(text, size);
            const x = (PAGE_WIDTH - textWidth) / 2;
            page.drawText(text, { x, y, size, font, ...options });
            return x; // return x so callers can draw underline if needed
          };

          // ── "Avi-on Lighting Controls" — bold italic 24pt, y≈572 ─────────────
          drawCentered('Avi-on Lighting Controls', 572, 24, fontTimesBoldItalic);

          // ── #Project Name# — bold underlined 24pt, y≈516 ─────────────────────
          const projName = projectData.projectName || '';
          const projNameY = 516;
          const projNameX = drawCentered(projName, projNameY, 24, fontTimesBold);
          const projNameWidth = fontTimesBold.widthOfTextAtSize(projName, 24);
          page.drawLine({
            start: { x: projNameX, y: projNameY - 4 },
            end: { x: projNameX + projNameWidth, y: projNameY - 4 },
            thickness: 1.2, color: rgb(0, 0, 0)
          });

          // ── #Project Address# — 18pt, y≈486 ──────────────────────────────────
          const addrParts = [projectData.address, projectData.city, projectData.state, projectData.zip].filter(Boolean);
          const addressLine = addrParts.length > 0
            ? `${projectData.address || ''} ${projectData.city || ''}${projectData.city && projectData.state ? ', ' : ''}${projectData.state || ''} ${projectData.zip || ''}`.trim()
            : '';
          drawCentered(addressLine, 486, 18, fontTimesRegular);

          // ── #Submittal Date# — 18pt, y≈452 ───────────────────────────────────
          drawCentered(projectData.submittalDate || '', 452, 18, fontTimesRegular);

          // ── "Lighting Controls Submittal" + "REV #" — bold 22pt ──────────────
          drawCentered('Lighting Controls Submittal', 268, 22, fontTimesBold);
          const revText = `REV ${projectData.revNumber || '0'}`;
          drawCentered(revText, 241, 22, fontTimesBold); // lowered from 251 → 241

          // ── Project Number / Quote Number (extra info block, 12pt) ───────────
          if (projectData.projectNumber || projectData.quoteNumber) {
            const infoLines = [];
            if (projectData.projectNumber) infoLines.push(`Project No: ${projectData.projectNumber}`);
            if (projectData.quoteNumber) infoLines.push(`Quote No: ${projectData.quoteNumber}`);
            let infoY = 205;
            infoLines.forEach(line => {
              drawCentered(line, infoY, 12, fontTimesRegular);
              infoY -= 18;
            });
          }

          // ── Footer — 10pt centered, y≈38 ─────────────────────────────────────
          const footer = 'www.avi-on.com  |  2700 Rasmussen RD, Ste L-10, Park City, UT  |  877.284.6687';
          drawCentered(footer, 38, 10, fontTimesRegular);
        } 
        else if (section.id === 'projectNotes') {
          const notes = sectionData?.projectNotes || [];
          if (notes.length === 0) {
            drawWrappedText("No project notes entered.", 532, fontRegular, 12, 40);
          } else {
            notes.forEach((note, index) => {
              drawWrappedText(`${index + 1}. ${note}`, 532, fontRegular, 12, 40);
              currentY -= 10;
            });
          }
        }
        else if (section.id === 'submittalReview') {
          const reviews = sectionData?.submittalReview;
          if (!reviews || !reviews.comments || reviews.comments.length === 0) {
            drawWrappedText("No review comments entered.", 532, fontRegular, 12, 40);
          } else {
            reviews.comments.forEach((comment, index) => {
              if (comment.trim() !== '') {
                drawWrappedText(`Comment: ${comment}`, 532, fontBold, 12, 40);
                currentY -= 4;
                drawWrappedText(`Response: ${reviews.responses[index] || '(No response)'}`, 532, fontRegular, 12, 40);
                currentY -= 15;
              }
            });
          }
        }
        else if (section.id === 'sequenceOfOperations') {
          const rows = sectionData?.sequenceOfOperations || [];
          
          const hasData = rows.some(r =>
            r.label || r.roomType || r.narrative || r.sensorTimeout ||
            r.vacancyMode || r.occupancyMode || r.dualTech || r.scheduleOn || r.scheduleOff ||
            r.scheduleOverride || r.manualOnOff || r.manualDimming || r.keySwitch ||
            r.sceneControl || r.graphicTouch || r.dlSwitching || r.dlDimming ||
            r.exteriorLocation || r.plugLoad || r.networked
          );

          if (!hasData) {
            // Need a regular page for the placeholder message
            page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
            pagesForLogo.push(page);
            page.drawText("Sequence of Operations", { x: 40, y: PAGE_HEIGHT - 60, size: 20, font: fontBold, color: rgb(0, 0.2, 0.5) });
            currentY = PAGE_HEIGHT - 100;
            drawWrappedText("No sequence of operations entered.", 532, fontTimesRegular, 12, 40);
          } else {
            // Use landscape page for the wide SOO table — no blank page added before this
            const SOO_W = 792; const SOO_H = 612;
            page = pdfDoc.addPage([SOO_W, SOO_H]);
            pagesForLogo.push(page);
            currentY = SOO_H - 85;

            // ── Header: title only ─────────────────────────────────────────────
            page.drawText("SEQUENCE OF OPERATIONS", {
              x: 20, y: currentY, size: 13, font: fontTimesBold, color: rgb(0, 0, 0)
            });
            currentY -= 20;

            // Scale everything down so more width goes to the narrative
            const HDR_FS   = 4.8;  // header label font size
            const HDR_LH   = 6.2;  // header line height
            const CELL_FS  = 6;    // cell content font size
            const CELL_LH  = 7.5;  // cell line height (row text leading)
            const HEADER_PAD = 4;  // horizontal padding each side in header cells

            const sooCols = [
              { label: 'Label',                k: 'label',           bool: false, minW: 18 },
              { label: 'Room Type',            k: 'roomType',        bool: false, minW: 32 },
              { label: 'Vacancy Mode',         k: 'vacancyMode',     bool: true,  minW: 0  },
              { label: 'Occupancy Mode',       k: 'occupancyMode',   bool: true,  minW: 0  },
              { label: 'Sensor Timeout',       k: 'sensorTimeout',   bool: false, minW: 0  },
              { label: 'Dual Technology',      k: 'dualTech',        bool: true,  minW: 0  },
              { label: 'Schedule On',          k: 'scheduleOn',      bool: true,  minW: 0  },
              { label: 'Schedule Off',         k: 'scheduleOff',     bool: true,  minW: 0  },
              { label: 'Schedule Override',    k: 'scheduleOverride',bool: true,  minW: 0  },
              { label: 'Manual On/Off',        k: 'manualOnOff',     bool: true,  minW: 0  },
              { label: 'Manual Dimming',       k: 'manualDimming',   bool: true,  minW: 0  },
              { label: 'Key Switch',           k: 'keySwitch',       bool: true,  minW: 0  },
              { label: 'Scene Control',        k: 'sceneControl',    bool: true,  minW: 0  },
              { label: 'Graphic Touchscreen',  k: 'graphicTouch',    bool: true,  minW: 0  },
              { label: 'DL Switching',         k: 'dlSwitching',     bool: true,  minW: 0  },
              { label: 'DL Dimming',           k: 'dlDimming',       bool: true,  minW: 0  },
              { label: 'Target Lighting',      k: 'targetLighting',  bool: false, minW: 0  },
              { label: 'Exterior Location',    k: 'exteriorLocation',bool: true,  minW: 0  },
              { label: 'Plug Load Control',    k: 'plugLoad',        bool: true,  minW: 0  },
              { label: 'Networked',            k: 'networked',       bool: true,  minW: 0  },
              { label: 'Notes',                k: 'notes',           bool: false, minW: 24 },
            ];

            // Set each column width = longest word in label + padding, measured at actual font
            sooCols.forEach(col => {
              const tokens = col.label.split(/[ \/\-]/);
              const longestW = tokens.reduce((max, t) =>
                Math.max(max, fontTimesBold.widthOfTextAtSize(t, HDR_FS)), 0);
              col.w = Math.max(col.minW, Math.ceil(longestW) + HEADER_PAD * 2);
            });

            const TABLE_X = 20;
            const fixedW = sooCols.reduce((s, c) => s + c.w, 0);
            const narrativeW = SOO_W - TABLE_X - fixedW - 20;
            const TABLE_W = fixedW + narrativeW;

            // HEADER_H = just enough for the most-wrapped column label + padding
            const maxHeaderLines = sooCols.reduce((max, col) => {
              const lines = wrapText(col.label, col.w - HEADER_PAD * 2, fontTimesBold, HDR_FS);
              return Math.max(max, lines.length);
            }, 1);
            const HEADER_H = maxHeaderLines * HDR_LH + HEADER_PAD * 2 + 2;

            const ROW_H_MIN = CELL_LH + 4;

            const drawSOOHeader = (pg, startY) => {
              pg.drawRectangle({
                x: TABLE_X, y: startY - HEADER_H, width: TABLE_W, height: HEADER_H,
                color: rgb(0.18, 0.31, 0.53), borderColor: rgb(0,0,0), borderWidth: 0.5
              });
              let hx = TABLE_X;
              sooCols.forEach(col => {
                pg.drawLine({ start: {x: hx + col.w, y: startY}, end: {x: hx + col.w, y: startY - HEADER_H}, thickness: 0.5, color: rgb(0.4, 0.5, 0.7) });
                const availW = col.w - HEADER_PAD * 2;
                const lines = wrapText(col.label, availW, fontTimesBold, HDR_FS);
                const totalTextH = lines.length * HDR_LH;
                const textStartY = startY - (HEADER_H - totalTextH) / 2 - HDR_LH + 2;
                lines.forEach((line, li) => {
                  const lw = fontTimesBold.widthOfTextAtSize(line, HDR_FS);
                  const lx = hx + HEADER_PAD + (availW - lw) / 2;
                  pg.drawText(line, { x: lx, y: textStartY - li * HDR_LH, size: HDR_FS, font: fontTimesBold, color: rgb(1,1,1) });
                });
                hx += col.w;
              });
              // Narrative header
              pg.drawLine({ start: {x: hx + narrativeW, y: startY}, end: {x: hx + narrativeW, y: startY - HEADER_H}, thickness: 0.5, color: rgb(0.4, 0.5, 0.7) });
              const narLabel = 'Narrative';
              const narLW = fontTimesBold.widthOfTextAtSize(narLabel, HDR_FS);
              pg.drawText(narLabel, { x: hx + (narrativeW - narLW) / 2, y: startY - HEADER_H / 2, size: HDR_FS, font: fontTimesBold, color: rgb(1,1,1) });
              return startY - HEADER_H;
            };

            const checkSOOPage = (neededH) => {
              if (currentY - neededH < 30) {
                page = pdfDoc.addPage([SOO_W, SOO_H]);
                pagesForLogo.push(page);
                currentY = SOO_H - 85;
                page.drawText("Sequence of Operations (Continued)", { x: TABLE_X, y: currentY, size: 11, font: fontTimesBold, color: rgb(0, 0.2, 0.5) });
                currentY -= 16;
                currentY = drawSOOHeader(page, currentY);
              }
            };

            currentY = drawSOOHeader(page, currentY);

            rows.forEach((row, rowIdx) => {
              const narLines = wrapText(row.narrative || '', narrativeW - 6, fontTimesRegular, CELL_FS);
              const roomTypeCol = sooCols.find(c => c.k === 'roomType');
              const roomTypeLines = wrapText((row.roomType || '').toString(), roomTypeCol.w - 4, fontTimesRegular, CELL_FS);
              const rowH = Math.max(ROW_H_MIN, Math.max(narLines.length, roomTypeLines.length) * CELL_LH + 4);
              checkSOOPage(rowH);

              const rowBg = rowIdx % 2 === 0 ? rgb(1, 1, 1) : rgb(0.94, 0.96, 0.99);
              page.drawRectangle({ x: TABLE_X, y: currentY - rowH, width: TABLE_W, height: rowH, color: rowBg, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.5 });

              let rx = TABLE_X;
              sooCols.forEach(col => {
                const cellMidY = currentY - (rowH / 2) - (CELL_FS / 2);
                if (col.bool) {
                  if (row[col.k]) {
                    const cx = rx + col.w / 2;
                    const cy = currentY - rowH / 2;
                    page.drawCircle({ x: cx, y: cy, size: 3, color: rgb(0.1, 0.2, 0.5) });
                  }
                } else if (col.k === 'roomType') {
                  const lines = wrapText((row[col.k] ?? '').toString(), col.w - 8, fontTimesRegular, CELL_FS);
                  const totalH = lines.length * CELL_LH;
                  let lineY = currentY - (rowH - totalH) / 2 - CELL_FS;
                  lines.forEach(line => {
                    const lw = fontTimesRegular.widthOfTextAtSize(line, CELL_FS);
                    page.drawText(line, { x: rx + (col.w - lw) / 2, y: lineY, size: CELL_FS, font: fontTimesRegular });
                    lineY -= CELL_LH;
                  });
                } else if (col.k === 'notes') {
                  let text = (row[col.k] ?? '').toString();
                  let tw = fontTimesRegular.widthOfTextAtSize(text, CELL_FS);
                  while (tw > col.w - 4 && text.length > 0) {
                    text = text.slice(0, -1);
                    tw = fontTimesRegular.widthOfTextAtSize(text + '..', CELL_FS);
                  }
                  if (tw < fontTimesRegular.widthOfTextAtSize((row[col.k] ?? '').toString(), CELL_FS)) text += '..';
                  page.drawText(text, { x: rx + 2, y: cellMidY, size: CELL_FS, font: fontTimesRegular });
                } else {
                  let text = (row[col.k] ?? '').toString();
                  let tw = fontTimesRegular.widthOfTextAtSize(text, CELL_FS);
                  while (tw > col.w - 4 && text.length > 0) {
                    text = text.slice(0, -1);
                    tw = fontTimesRegular.widthOfTextAtSize(text + '..', CELL_FS);
                  }
                  if (tw < fontTimesRegular.widthOfTextAtSize((row[col.k] ?? '').toString(), CELL_FS)) text += '..';
                  const tw2 = fontTimesRegular.widthOfTextAtSize(text, CELL_FS);
                  page.drawText(text, { x: rx + (col.w - tw2) / 2, y: cellMidY, size: CELL_FS, font: fontTimesRegular });
                }
                rx += col.w;
                page.drawLine({ start: {x: rx, y: currentY}, end: {x: rx, y: currentY - rowH}, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
              });

              // Narrative column — left-aligned
              let narY = currentY - CELL_LH + 1;
              narLines.forEach(line => {
                page.drawText(line, { x: rx + 3, y: narY, size: CELL_FS, font: fontTimesRegular });
                narY -= CELL_LH;
              });

              currentY -= rowH;
            });

            // Close bottom border
            page.drawLine({ start: {x: TABLE_X, y: currentY}, end: {x: TABLE_X + TABLE_W, y: currentY}, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
          }
        }
        else {
          drawWrappedText("[ Placeholder: No file was uploaded for this section ]", 532, fontRegular, 12, 40, rgb(0.5, 0.5, 0.5));
          
          const importedData = sectionData?.[section.id];
          if (importedData && importedData.path && !importedData.file) {
            currentY -= 15;
            drawWrappedText(`Reference Link: ${importedData.path}`, 532, fontRegular, 10, 40);
          }
        }
      }

      // Draw the final Table of Contents
      if (tocPage) {
        let tocY = PAGE_HEIGHT - 100;
        tocPage.drawText("Document Section", { x: 40, y: tocY, size: 14, font: fontBold });
        tocPage.drawText("Page", { x: 500, y: tocY, size: 14, font: fontBold }); tocY -= 15;
        tocPage.drawLine({ start: { x: 40, y: tocY }, end: { x: 535, y: tocY }, thickness: 1, color: rgb(0.2, 0.2, 0.2) }); tocY -= 25;

        for (const entry of tocEntries) {
          tocPage.drawText(entry.title, { x: 40, y: tocY, size: 12, font: fontRegular });
          tocPage.drawText(entry.pageNum.toString(), { x: 510, y: tocY, size: 12, font: fontRegular });
          const textWidth = fontRegular.widthOfTextAtSize(entry.title, 12);
          tocPage.drawLine({ start: { x: 40 + textWidth + 10, y: tocY + 3 }, end: { x: 495, y: tocY + 3 }, thickness: 1, color: rgb(0.6, 0.6, 0.6), dashArray: [2, 4] });
          tocY -= 25; 
        }
      }

      let logoImage = null;
      let logoDims = null;
      
      if (settings.logoPath instanceof File) {
        try {
          const fileType = settings.logoPath.type.toLowerCase();
          let finalBytes;

          if (fileType === 'image/jpeg' || fileType === 'image/jpg') {
            finalBytes = await settings.logoPath.arrayBuffer();
            logoImage = await pdfDoc.embedJpg(finalBytes);
          } else if (fileType === 'image/png') {
            finalBytes = await settings.logoPath.arrayBuffer();
            logoImage = await pdfDoc.embedPng(finalBytes);
          } else {
            finalBytes = await imageToPngBytes(settings.logoPath);
            logoImage = await pdfDoc.embedPng(finalBytes);
          }
          
          if (logoImage) {
            logoDims = logoImage.scaleToFit(120, 50);
          }
        } catch (imgErr) {
          console.error("Failed to embed logo", imgErr);
        }
      }

      // Apply the parsed Logo only to specifically generated pages (excluding the cover)
      if (logoImage && logoDims) {
        pagesForLogo.forEach((logoPage) => {
          const { width, height } = logoPage.getSize();
          logoPage.drawImage(logoImage, {
            x: width - logoDims.width - 40, 
            y: height - logoDims.height - 30, 
            width: logoDims.width,
            height: logoDims.height,
          });
        });
      }

      // Apply Page Numbers to all pages globally
      const allPages = pdfDoc.getPages();
      const totalPages = allPages.length;

      allPages.forEach((page, index) => {
        const { width, height } = page.getSize();

        if (settings.includePageNumbers) {
          const pageText = `Page ${index + 1} of ${totalPages}`;
          const textWidth = fontRegular.widthOfTextAtSize(pageText, 10);
          
          page.drawRectangle({
            x: (width / 2) - (textWidth / 2) - 5,
            y: 15,
            width: textWidth + 10,
            height: 15,
            color: rgb(1, 1, 1),
            opacity: 0.8
          });

          page.drawText(pageText, {
            x: (width / 2) - (textWidth / 2),
            y: 20,
            size: 10,
            font: fontRegular,
            color: rgb(0, 0, 0)
          });
        }
      });

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url;
      link.download = `${projectData.projectName || 'Submittal'}_REV${projectData.revNumber || '0'}.pdf`.replace(/\s+/g, '_');
      document.body.appendChild(link); link.click();
      document.body.removeChild(link); URL.revokeObjectURL(url);
      onClose(); 

    } catch (error) { 
      console.error(error);
      alert("Something went wrong while generating the PDF. Check console for details."); 
    } 
    finally { setIsGenerating(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header"><h2>Generate Submittal PDF</h2><button className="close-btn" onClick={onClose}>×</button></div>
        <div className="modal-body">
          <p className="modal-note">
            Review and modify sections to include in the final package. The system will merge uploaded PDFs and generate placeholders for empty sections.
          </p>

          <div className="generate-section-head">
            <strong className="generate-section-head__title">Sections to Include:</strong>
            <button className="btn-small btn-secondary" onClick={handleToggleAll}>
              {allSelected ? '☐ Deselect All' : '☑ Select All'}
            </button>
          </div>

          <div className="generate-section-list">
            {sections.map(section => (
              <div key={section.id} className={`generate-section-row ${localChecklist[section.id] ? 'is-selected' : ''}`}>
                <input type="checkbox" checked={localChecklist[section.id] || false} onChange={(e) => setLocalChecklist(prev => ({ ...prev, [section.id]: e.target.checked }))} />
                <span>{section.title}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer"><button className="btn btn-secondary" onClick={onClose} disabled={isGenerating}>Cancel</button><button className="btn btn-success" onClick={handleGenerate} disabled={isGenerating}>{isGenerating ? '⏳ Compiling Document...' : '📄 Generate & Download PDF'}</button></div>
      </div>
    </div>
  );
}

export default App;