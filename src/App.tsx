/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import { Upload, FileText, Search, ZoomIn, ZoomOut, ChevronLeft, ChevronRight, ChevronDown, Info, AlertCircle, Sun, Moon, Bug, X, Map, Check, Download } from 'lucide-react';
import { cn } from './lib/utils';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

interface BOMEntry {
  "Part Reference": string;
  "Part Number"?: string;
  "Component_Name"?: string;
  "Optional"?: string;
  description?: string;
  quantity?: string;
  originalLine?: string;
  lineNumber?: number;
  [key: string]: any;
}

interface MatchResult {
  pageNumber: number;
  viewport: pdfjsLib.PageViewport;
  transform: number[];
  width: number;
  height: number;
  text: string;
  color?: string;
}

interface ComparisonResult {
  designator: string;
  status: 'added' | 'removed' | 'modified' | 'identical';
  bom1Entry?: BOMEntry;
  bom2Entry?: BOMEntry;
  diffFields: string[];
}

const sortBOMData = (data: BOMEntry[]) => {
  return [...data].sort((a, b) => {
    const refA = a["Part Reference"] || "";
    const refB = b["Part Reference"] || "";

    // Extract page number (first two digits after letters, allowing optional spaces/underscores)
    const matchA = refA.match(/^[A-Za-z]+[\s_]*(\d{2})/);
    const matchB = refB.match(/^[A-Za-z]+[\s_]*(\d{2})/);

    const pageA = matchA ? parseInt(matchA[1], 10) : 9999;
    const pageB = matchB ? parseInt(matchB[1], 10) : 9999;

    if (pageA !== pageB) {
      return pageA - pageB;
    }

    // Fallback to standard alphanumeric sort
    return refA.localeCompare(refB, undefined, { numeric: true, sensitivity: 'base' });
  });
};

export default function App() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [bomFiles, setBomFiles] = useState<Record<string, BOMEntry[]>>({});
  const [activeBom, setActiveBom] = useState<string | null>(null);
  
  const bomData = useMemo(() => activeBom ? bomFiles[activeBom] : [], [bomFiles, activeBom]);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfPageTexts, setPdfPageTexts] = useState<string[][]>([]);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInputValue, setPageInputValue] = useState("1");
  const [scale, setScale] = useState(1.5);
  const [selectedDesignator, setSelectedDesignator] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [comparisonResults, setComparisonResults] = useState<ComparisonResult[] | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const [compareWithBom, setCompareWithBom] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [showDebugModal, setShowDebugModal] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);
  const [viewportRect, setViewportRect] = useState({ top: 0, left: 0, width: 0, height: 0 });
  const [componentStatuses, setComponentStatuses] = useState<Record<string, 'confirmed' | 'doubtful'>>({});
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input or textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const key = e.key.toLowerCase();

      // Status shortcuts
      if (selectedDesignator) {
        if (key === 'c') {
          setComponentStatuses(prev => {
            const next = { ...prev };
            if (next[selectedDesignator] === 'confirmed') {
              delete next[selectedDesignator];
            } else {
              next[selectedDesignator] = 'confirmed';
              // Also clear doubtful if it was set
              if (next[selectedDesignator] === 'doubtful') delete next[selectedDesignator];
            }
            return next;
          });
        } else if (key === 'd') {
          setComponentStatuses(prev => {
            const next = { ...prev };
            if (next[selectedDesignator] === 'doubtful') {
              delete next[selectedDesignator];
            } else {
              next[selectedDesignator] = 'doubtful';
              // Also clear confirmed if it was set
              if (next[selectedDesignator] === 'confirmed') delete next[selectedDesignator];
            }
            return next;
          });
        } else if (key === 'x') {
          setComponentStatuses(prev => {
            const next = { ...prev };
            delete next[selectedDesignator];
            return next;
          });
        }
      }

      // Navigation shortcuts
      if (key === 'arrowleft') {
        setCurrentPage(prev => Math.max(1, prev - 1));
      } else if (key === 'arrowright') {
        setCurrentPage(prev => Math.min(pdfDoc?.numPages || 1, prev + 1));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedDesignator, pdfDoc]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const groupedBomData = useMemo(() => {
    const groups: Record<number, BOMEntry[]> = {};
    const unknownGroup: BOMEntry[] = [];

    bomData.forEach(entry => {
      const ref = entry["Part Reference"] || "";
      const match = ref.match(/^[A-Za-z]+[\s_]*(\d{2})/);
      const page = match ? parseInt(match[1], 10) : null;

      if (page !== null) {
        if (!groups[page]) groups[page] = [];
        groups[page].push(entry);
      } else {
        unknownGroup.push(entry);
      }
    });

    const sortedGroups = Object.keys(groups)
      .map(Number)
      .sort((a, b) => a - b)
      .map(page => ({ page, entries: groups[page] }));

    if (unknownGroup.length > 0) {
      sortedGroups.push({ page: 9999, entries: unknownGroup });
    }

    return sortedGroups;
  }, [bomData]);

  // Update viewport rect for minimap
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const updateViewport = () => {
      const { scrollTop, scrollLeft, clientWidth, clientHeight } = container;
      const { width: canvasWidth, height: canvasHeight } = canvas;
      
      setViewportRect({
        top: (scrollTop / canvasHeight) * 100,
        left: (scrollLeft / canvasWidth) * 100,
        width: (clientWidth / canvasWidth) * 100,
        height: (clientHeight / canvasHeight) * 100
      });
    };

    container.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    updateViewport();

    // Also update when scale or page changes
    const timeout = setTimeout(updateViewport, 100);

    return () => {
      container.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
      clearTimeout(timeout);
    };
  }, [pdfDoc, currentPage, scale, isLoading, matches]);

  // Render Minimap Thumbnail
  useEffect(() => {
    if (!pdfDoc || !minimapCanvasRef.current || !showMinimap) return;

    const renderMinimap = async () => {
      try {
        const page = await pdfDoc.getPage(currentPage);
        const minimapCanvas = minimapCanvasRef.current!;
        const ctx = minimapCanvas.getContext('2d')!;
        
        // Fixed width for minimap thumbnail
        const minimapWidth = 180;
        const viewport = page.getViewport({ scale: 1 });
        const minimapScale = minimapWidth / viewport.width;
        const minimapViewport = page.getViewport({ scale: minimapScale });

        minimapCanvas.width = minimapViewport.width;
        minimapCanvas.height = minimapViewport.height;

        await page.render({
          canvasContext: ctx,
          viewport: minimapViewport
        }).promise;
      } catch (err) {
        console.error("Error rendering minimap:", err);
      }
    };

    renderMinimap();
  }, [pdfDoc, currentPage, showMinimap]);

  const handleMinimapClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const minimapCanvas = minimapCanvasRef.current;
    if (!container || !canvas || !minimapCanvas) return;

    const rect = minimapCanvas.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) / rect.width;
    const clickY = (e.clientY - rect.top) / rect.height;

    const targetScrollLeft = clickX * canvas.width - container.clientWidth / 2;
    const targetScrollTop = clickY * canvas.height - container.clientHeight / 2;

    container.scrollTo({
      left: Math.max(0, targetScrollLeft),
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth'
    });
  };

  // Handle PDF Upload
  const handleCanvasClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!pdfDoc || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    const page = await pdfDoc.getPage(currentPage);
    const viewport = page.getViewport({ scale });
    const textContent = await page.getTextContent();

    for (const item of textContent.items as any[]) {
      if (!('str' in item)) continue;

      const tx = pdfjsLib.Util.transform(
        pdfjsLib.Util.transform(viewport.transform, item.transform),
        [1, 0, 0, -1, 0, 0]
      );

      const itemX = tx[4];
      const itemY = tx[5] - item.height * scale;
      const itemWidth = item.width * scale;
      const itemHeight = item.height * scale;

      const padding = 10;
      if (
        x >= itemX - padding &&
        x <= itemX + itemWidth + padding &&
        y >= itemY - padding &&
        y <= itemY + itemHeight + padding
      ) {
        const text = item.str.trim();
        const found = bomData.find(entry => {
          const ref = entry["Part Reference"];
          const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`^${escapeRegExp(ref)}[A-Za-z]*$`, 'i');
          return regex.test(text) || text === ref;
        });

        if (found) {
          setSelectedDesignator(found["Part Reference"]);
          setSelectedGroup(null);
          return;
        }
      }
    }
  };

  // Auto-scroll BOM list when a designator is selected
  useEffect(() => {
    if (selectedDesignator) {
      const group = groupedBomData.find(g => 
        g.entries.some(e => e["Part Reference"] === selectedDesignator)
      );
      
      if (group) {
        setExpandedGroups(prev => {
          const next = new Set(prev);
          next.add(group.page);
          return next;
        });
        
        setTimeout(() => {
          const element = document.getElementById(`bom-item-${selectedDesignator}`);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 150);
      }
    }
  }, [selectedDesignator, groupedBomData]);

  const handlePdfUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      setPdfFile(file);
      setError(null);
      setSelectedDesignator(null);
      setSelectedGroup(null);
      loadPdf(file);
    } else {
      setError('Please upload a valid PDF file.');
    }
  };

  useEffect(() => {
    setPageInputValue(currentPage.toString());
  }, [currentPage]);

  const handlePageInputSubmit = () => {
    const pageNum = parseInt(pageInputValue, 10);
    if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= numPages) {
      setCurrentPage(pageNum);
    } else {
      setPageInputValue(currentPage.toString());
    }
  };

  // Handle BOM Upload
  const handleBomUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      setSelectedDesignator(null);
      setSelectedGroup(null);
      
      const cleanString = (val: any): string => {
        if (val === null || val === undefined) return '';
        return String(val).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      };

      const processTextContent = (text: string, fileName: string) => {
        // Strip BOM if present
        if (text.charCodeAt(0) === 0xFEFF) {
          text = text.substring(1);
        }
        const lines = text.split(/\r?\n/).filter(line => line.trim());
        
        if (lines.length === 0) return;

        // Check if the first line looks like a header
        const firstLine = lines[0];
        const isTabSeparated = firstLine.includes('\t');
        const isCommaSeparated = firstLine.includes(',');
        const delimiter = isTabSeparated ? '\t' : (isCommaSeparated ? ',' : /\s{2,}/);
        
        // Split all lines into a grid
        const grid = lines.map(line => line.split(delimiter).map(p => cleanString(p)));
        
        let refIdx = -1;
        let pnIdx = -1;
        let nameIdx = -1;
        let optIdx = -1;
        let compTypeIdx = -1;

        // Check if we have a valid grid
        if (grid.length > 0) {
          const numCols = Math.max(...grid.map(row => row.length));
          
          // If it's just 1 column, the delimiter is probably wrong, or it's unstructured
          if (numCols > 1) {
            // Analyze each column to guess its type
            for (let col = 0; col < numCols; col++) {
              let refScore = 0;
              let pnScore = 0;
              let nameScore = 0;
              let optScore = 0;
              let compTypeScore = 0;
              
              let validRows = 0;
              
              // Check up to 10 rows to determine column type
              for (let row = 0; row < Math.min(grid.length, 10); row++) {
                const cell = grid[row][col];
                if (!cell) continue;
                
                // If it's the first row, check if it matches known headers
                if (row === 0) {
                  if (/Part[\s_]*Referenc|^Reference$|^RefDes$|^Designator$|^Ref$|^Location$|^Part$|插件位置/i.test(cell)) refScore += 10;
                  if (/Part[\s_]*Number|^P\/?N$|^PN$|^Material$|^Item$|Item[\s_]*Number/i.test(cell)) pnScore += 10;
                  if (/Component[\s_]*Name|^Name$|^Component$|^Value$|^Part[\s_]*Type$|Item[\s_]*Description/i.test(cell)) nameScore += 10;
                  if (/Optional|^Opt$|^DNP$/i.test(cell)) optScore += 10;
                  if (/Comp[\s_]*Type|^Type$/i.test(cell)) compTypeScore += 10;
                }
                
                validRows++;
                
                // Data heuristics
                if (/^[A-Z]{1,3}\d+[A-Z]?$/i.test(cell)) {
                  refScore++;
                } else if (/^[A-Z0-9-]{6,}$/i.test(cell) && !/\s/.test(cell) && !/OHM|FARAD|VOLT|WATT/i.test(cell)) {
                  pnScore++;
                } else if (/\s/.test(cell) || /OHM|FARAD|VOLT|WATT|RES|CAP|IND|MLCC/i.test(cell)) {
                  nameScore++;
                } else if (/^(N\/A|@|DNP|NO\s*STUFF|OPTIONAL)$/i.test(cell)) {
                  optScore++;
                } else if (/^[S]$/i.test(cell)) {
                  compTypeScore++;
                }
              }
              
              // Assign column based on highest score
              if (validRows > 0) {
                const maxScore = Math.max(refScore, pnScore, nameScore, optScore, compTypeScore);
                if (maxScore > 0) { // Only assign if there's some evidence
                  if (maxScore === refScore && refIdx === -1) refIdx = col;
                  else if (maxScore === pnScore && pnIdx === -1) pnIdx = col;
                  else if (maxScore === nameScore && nameIdx === -1) nameIdx = col;
                  else if (maxScore === optScore && optIdx === -1) optIdx = col;
                  else if (maxScore === compTypeScore && compTypeIdx === -1) compTypeIdx = col;
                }
              }
            }
          }
        }
        
        const processedData: BOMEntry[] = [];
        let lastDesignators: string[] = [];

        if (refIdx !== -1 || pnIdx !== -1) {
          // Structured parsing
          // Check if the first row is a header row (if it doesn't match data heuristics)
          let startRow = 0;
          if (grid.length > 0) {
            const firstRowRef = refIdx !== -1 ? grid[0][refIdx] : '';
            const firstRowPn = pnIdx !== -1 ? grid[0][pnIdx] : '';
            // If the first row's Ref doesn't look like a Ref, or PN doesn't look like a PN, it's probably a header
            if ((firstRowRef && !/^[A-Z]{1,3}\d+[A-Z]?$/i.test(firstRowRef)) || 
                (firstRowPn && !/^[A-Z0-9-]{6,}$/i.test(firstRowPn))) {
              startRow = 1;
            }
          }

          for (let i = startRow; i < grid.length; i++) {
            const parts = grid[i];
            if (parts.length === 0 || (parts.length === 1 && !parts[0])) continue;

            const designatorRaw = refIdx !== -1 ? parts[refIdx] : '';
            const partNumber = pnIdx !== -1 ? parts[pnIdx] : '';
            const compType = compTypeIdx !== -1 ? parts[compTypeIdx] : '';
            
            if (!designatorRaw && !partNumber) continue;

            const designators = cleanString(designatorRaw).toUpperCase().split(',').map(d => d.trim()).filter(d => d);
            
            if (designators.length > 0) {
              lastDesignators = designators;
              designators.forEach(d => {
                const entry: BOMEntry = {
                  "Part Reference": d,
                  "Part Number": cleanString(partNumber),
                  "Component_Name": nameIdx !== -1 ? cleanString(parts[nameIdx]) : '',
                  "Optional": optIdx !== -1 ? cleanString(parts[optIdx]) : '',
                  description: parts.join(' '),
                  originalLine: lines[i],
                  lineNumber: i + 1
                };
                processedData.push(entry);
              });
            } else if (partNumber && compType.toLowerCase() === 's' && lastDesignators.length > 0) {
              // Second source for last seen designators
              lastDesignators.forEach(d => {
                // Find all entries for this designator that were added in the previous step
                // Since we process row by row, we can just look at the most recent entries
                for (let j = processedData.length - 1; j >= 0; j--) {
                  if (processedData[j]["Part Reference"] === d) {
                    const existingPn = processedData[j]["Part Number"];
                    processedData[j]["Part Number"] = existingPn ? `${existingPn} / ${cleanString(partNumber)}` : cleanString(partNumber);
                    // Only update the most recent one for this designator
                    break;
                  }
                }
              });
            }
          }
        } else {
          // Fallback to regex-based parsing for unstructured text
          const designatorRegex = /^[A-Z]{1,3}\d+[A-Z]?$/i;
          const pnRegex = /^[A-Z0-9-]{6,}$/i;
          
          lines.forEach((line, index) => {
            const parts = line.trim().split(/[\s,\t]+/);
            let foundDesignators: string[] = [];
            let foundPN = '';
            let foundName: string[] = [];
            
            for (const part of parts) {
              const cleanedPart = cleanString(part);
              if (designatorRegex.test(cleanedPart) && !/OHM|FARAD|VOLT|WATT/i.test(cleanedPart)) {
                foundDesignators.push(cleanedPart.toUpperCase());
              } else if (!foundPN && pnRegex.test(cleanedPart) && !/OHM|FARAD|VOLT|WATT/i.test(cleanedPart)) {
                foundPN = cleanedPart;
              } else {
                foundName.push(cleanedPart);
              }
            }
            
            if (foundDesignators.length > 0 || foundPN) {
              (foundDesignators.length > 0 ? foundDesignators : ['']).forEach(d => {
                processedData.push({
                  "Part Reference": d,
                  "Part Number": foundPN,
                  "Component_Name": foundName.join(' '),
                  description: cleanString(line),
                  originalLine: cleanString(line),
                  lineNumber: index + 1
                });
              });
            }
          });
        }
        
        setBomFiles(prev => ({ ...prev, [fileName]: sortBOMData(processedData) }));
        setActiveBom(fileName);
      };

      Array.from(files).forEach((file: File) => {
        const isTextFile = file.name.endsWith('.txt') || file.type === 'text/plain';
        const isExcelFile = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');
        
        if (isExcelFile) {
          const reader = new FileReader();
          reader.onload = (event) => {
            try {
              const data = new Uint8Array(event.target?.result as ArrayBuffer);
              const workbook = XLSX.read(data, { type: 'array' });
              const firstSheetName = workbook.SheetNames[0];
              const worksheet = workbook.Sheets[firstSheetName];
              const jsonData = XLSX.utils.sheet_to_json(worksheet);
              
              let lastDesignators: string[] = [];
              const processedData: BOMEntry[] = [];
              
              jsonData.forEach((row: any) => {
                const designatorKey = Object.keys(row).find(k => 
                  /Part[\s_]*Reference|^designator$|^ref$|^reference$|^refdes$|^location$|^part$|插件位置/i.test(cleanString(k))
                );
                const pnKey = Object.keys(row).find(k => 
                  /Part[\s_]*Number|^pn$|^p\/n$|^material$|^item$|Item[\s_]*Number/i.test(cleanString(k))
                );
                const nameKey = Object.keys(row).find(k => 
                  /Component[\s_]*Name|^name$|^desc|^value$|^part[\s_]*type$|Item[\s_]*Description/i.test(cleanString(k))
                );
                const optKey = Object.keys(row).find(k => 
                  /Optional|^opt$|^dnp$/i.test(cleanString(k))
                );
                const compTypeKey = Object.keys(row).find(k => 
                  /Comp[\s_]*Type|^Type$/i.test(cleanString(k))
                );
                
                const designatorRaw = cleanString(designatorKey ? row[designatorKey] : Object.values(row)[0]).toUpperCase();
                const designators = designatorRaw.split(',').map(d => d.trim()).filter(d => d);
                const partNumber = cleanString(pnKey ? row[pnKey] : '');
                const compType = cleanString(compTypeKey ? row[compTypeKey] : '');
                
                if (designators.length > 0) {
                  lastDesignators = designators;
                  designators.forEach(d => {
                    const newRow: any = {};
                    Object.keys(row).forEach(key => {
                      newRow[key] = cleanString(row[key]);
                    });
                    
                    newRow["Part Reference"] = d;
                    newRow["Part Number"] = partNumber;
                    newRow["Component_Name"] = cleanString(nameKey ? row[nameKey] : '');
                    newRow["Optional"] = cleanString(optKey ? row[optKey] : '');
                    
                    processedData.push(newRow as BOMEntry);
                  });
                } else if (partNumber && compType.toLowerCase() === 's' && lastDesignators.length > 0) {
                  // Second source for last seen designators
                  lastDesignators.forEach(d => {
                    for (let j = processedData.length - 1; j >= 0; j--) {
                      if (processedData[j]["Part Reference"] === d) {
                        const existingPn = processedData[j]["Part Number"];
                        processedData[j]["Part Number"] = existingPn ? `${existingPn} / ${partNumber}` : partNumber;
                        break;
                      }
                    }
                  });
                }
              });

              const finalData = processedData.filter(d => d["Part Reference"]);
              setBomFiles(prev => ({ ...prev, [file.name]: sortBOMData(finalData) }));
              setActiveBom(file.name);
            } catch (err) {
              console.error('Excel parsing failed, falling back to text parsing:', err);
              const textReader = new FileReader();
              textReader.onload = (textEvent) => {
                const text = textEvent.target?.result as string;
                processTextContent(text, file.name);
              };
              textReader.readAsText(file);
            }
          };
          reader.readAsArrayBuffer(file);
        } else if (isTextFile) {
          const reader = new FileReader();
          reader.onload = (event) => {
            const text = event.target?.result as string;
            processTextContent(text, file.name);
          };
          reader.readAsText(file);
        } else {
          // Handle CSV
          Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
              const data = results.data as any[];
            let lastDesignators: string[] = [];
            const processedData = data.reduce((acc: BOMEntry[], row: any) => {
              const designatorKey = Object.keys(row).find(k => 
                /Part[\s_]*Reference|^designator$|^ref$|^reference$|^refdes$|^location$|^part$|插件位置/i.test(cleanString(k))
              );
              const pnKey = Object.keys(row).find(k => 
                /Part[\s_]*Number|^pn$|^p\/n$|^material$|^item$|Item[\s_]*Number/i.test(cleanString(k))
              );
              const nameKey = Object.keys(row).find(k => 
                /Component[\s_]*Name|^name$|^desc|^value$|^part[\s_]*type$|Item[\s_]*Description/i.test(cleanString(k))
              );
              const optKey = Object.keys(row).find(k => 
                /Optional|^opt$|^dnp$/i.test(cleanString(k))
              );
              const compTypeKey = Object.keys(row).find(k => 
                /Comp[\s_]*Type|^Type$/i.test(cleanString(k))
              );
              
              const designatorRaw = cleanString(designatorKey ? row[designatorKey] : Object.values(row)[0]).toUpperCase();
              const designators = designatorRaw.split(',').map(d => d.trim()).filter(d => d);
              const partNumber = cleanString(pnKey ? row[pnKey] : '');
              const compType = cleanString(compTypeKey ? row[compTypeKey] : '');
              
              if (designators.length > 0) {
                lastDesignators = designators;
                designators.forEach(d => {
                  const newRow: any = {};
                  Object.keys(row).forEach(key => {
                    newRow[key] = cleanString(row[key]);
                  });
                  
                  newRow["Part Reference"] = d;
                  newRow["Part Number"] = partNumber;
                  newRow["Component_Name"] = cleanString(nameKey ? row[nameKey] : '');
                  newRow["Optional"] = cleanString(optKey ? row[optKey] : '');
                  
                  acc.push(newRow as BOMEntry);
                });
              } else if (partNumber && compType.toLowerCase() === 's' && lastDesignators.length > 0) {
                // Second source for last seen designators
                lastDesignators.forEach(d => {
                  for (let j = acc.length - 1; j >= 0; j--) {
                    if (acc[j]["Part Reference"] === d) {
                      const existingPn = acc[j]["Part Number"];
                      acc[j]["Part Number"] = existingPn ? `${existingPn} / ${partNumber}` : partNumber;
                      break;
                    }
                  }
                });
              }
              return acc;
            }, []);
              const finalData = processedData.filter(d => d["Part Reference"]);
              setBomFiles(prev => ({ ...prev, [file.name]: sortBOMData(finalData) }));
              setActiveBom(file.name);
            },
            error: (err) => {
              setError('Failed to parse BOM file.');
              console.error(err);
            }
          });
        }
      });
    }
  };

  const handleCompare = (bom1Name: string, bom2Name: string) => {
    const bom1 = bomFiles[bom1Name];
    const bom2 = bomFiles[bom2Name];
    if (!bom1 || !bom2) return;

    const results: ComparisonResult[] = [];
    const allDesignators = new Set([
      ...bom1.map(e => e["Part Reference"]),
      ...bom2.map(e => e["Part Reference"])
    ]);

    allDesignators.forEach(designator => {
      if (!designator) return;
      const entry1 = bom1.find(e => e["Part Reference"] === designator);
      const entry2 = bom2.find(e => e["Part Reference"] === designator);

      if (entry1 && !entry2) {
        results.push({ designator, status: 'removed', bom1Entry: entry1, diffFields: [] });
      } else if (!entry1 && entry2) {
        results.push({ designator, status: 'added', bom2Entry: entry2, diffFields: [] });
      } else if (entry1 && entry2) {
        const diffFields: string[] = [];
        if (entry1["Part Number"] !== entry2["Part Number"]) diffFields.push("Part Number");
        if (entry1["Component_Name"] !== entry2["Component_Name"]) diffFields.push("Component_Name");
        if (entry1["Optional"] !== entry2["Optional"]) diffFields.push("Optional");

        if (diffFields.length > 0) {
          results.push({ designator, status: 'modified', bom1Entry: entry1, bom2Entry: entry2, diffFields });
        } else {
          results.push({ designator, status: 'identical', bom1Entry: entry1, bom2Entry: entry2, diffFields: [] });
        }
      }
    });

    setComparisonResults(results);
    setIsComparing(true);
    setCompareWithBom(bom2Name);
  };

  const loadPdf = async (file: File) => {
    setIsLoading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const doc = await loadingTask.promise;
      setPdfDoc(doc);
      setNumPages(doc.numPages);
      setCurrentPage(1);
      setPageInputValue("1");

      // Extract text for all pages for fast searching
      const pageTexts: string[][] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const textContent = await page.getTextContent();
        pageTexts.push(textContent.items.map((item: any) => item.str));
      }
      setPdfPageTexts(pageTexts);
    } catch (err) {
      setError('Error loading PDF.');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  // Render PDF Page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    let renderTask: any = null;
    let isCancelled = false;

    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(currentPage);
        if (isCancelled) return;

        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current!;
        const context = canvas.getContext('2d')!;

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        };

        renderTask = page.render(renderContext);
        await renderTask.promise;

        if (isCancelled) return;

        // Clear previous matches before new highlights
        setMatches([]);

        // After rendering, if we have a selected designator or group, highlight it
        if (isComparing && comparisonResults) {
          const added = comparisonResults.filter(r => r.status === 'added').map(r => r.designator);
          const removed = comparisonResults.filter(r => r.status === 'removed').map(r => r.designator);
          const modified = comparisonResults.filter(r => r.status === 'modified').map(r => r.designator);

          if (added.length > 0) await searchAndHighlight(page, viewport, added, '#22c55e'); // Green
          if (removed.length > 0) await searchAndHighlight(page, viewport, removed, '#ef4444'); // Red
          if (modified.length > 0) await searchAndHighlight(page, viewport, modified, '#f59e0b'); // Amber
        } else {
          // Highlight all components with statuses on this page
          const confirmed = Object.keys(componentStatuses).filter(d => componentStatuses[d] === 'confirmed');
          const doubtful = Object.keys(componentStatuses).filter(d => componentStatuses[d] === 'doubtful');
          
          if (confirmed.length > 0) await searchAndHighlight(page, viewport, confirmed, '#22c55e');
          if (doubtful.length > 0) await searchAndHighlight(page, viewport, doubtful, '#ef4444');

          if (selectedDesignator) {
            searchAndHighlight(page, viewport, [selectedDesignator], '#3b82f6', true); // Blue for selection
          } else if (selectedGroup !== null) {
            const group = groupedBomData.find(g => g.page === selectedGroup);
            if (group) {
              const terms = group.entries.map(e => e["Part Reference"]);
              searchAndHighlight(page, viewport, terms, '#3b82f6', true); // Blue for selection
            }
          }
        }
      } catch (error: any) {
        if (error.name === 'RenderingCancelledException') {
          // Ignore cancelled renders
        } else {
          console.error("Error rendering page:", error);
        }
      }
    };

    renderPage();

    return () => {
      isCancelled = true;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [pdfDoc, currentPage, scale, selectedDesignator, selectedGroup, groupedBomData, isLoading, isComparing, comparisonResults, componentStatuses]);

  useEffect(() => {
    if (selectedGroup !== null && selectedGroup !== 9999) {
      setCurrentPage(prev => (prev !== selectedGroup && selectedGroup <= numPages) ? selectedGroup : prev);
    } else if (selectedDesignator && pdfPageTexts.length > 0) {
      const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Allow optional letter suffix (e.g., Q0301 matching Q0301A, Q0301B, etc.)
      const regex = new RegExp(`\\b${escapeRegExp(selectedDesignator)}[A-Za-z]*\\b`, 'i');
      
      const pageIndex = pdfPageTexts.findIndex(pageItems => 
        pageItems.some(str => regex.test(str) || str === selectedDesignator)
      );
      
      if (pageIndex !== -1) {
        const targetPage = pageIndex + 1;
        setCurrentPage(prev => prev !== targetPage ? targetPage : prev);
      }
    }
  }, [selectedDesignator, selectedGroup, pdfPageTexts, numPages]);

  // Auto-zoom when selecting a component
  useEffect(() => {
    if (selectedDesignator) {
      setScale(prev => Math.max(prev, 2.5));
    }
  }, [selectedDesignator]);

  // Auto-scroll to selected component
  useEffect(() => {
    if (selectedDesignator && matches.length > 0 && containerRef.current) {
      const match = matches.find(m => {
        const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapeRegExp(selectedDesignator)}[A-Za-z]*\\b`, 'i');
        return regex.test(m.text) || m.text === selectedDesignator;
      });

      if (match) {
        // Calculate coordinates on the canvas
        const tx = pdfjsLib.Util.transform(
          pdfjsLib.Util.transform(match.viewport.transform, match.transform),
          [1, 0, 0, -1, 0, 0]
        );

        const currentScale = match.viewport.scale;
        const x = tx[4];
        const y = tx[5] - match.height * currentScale;

        // Center the match in the container
        const container = containerRef.current;
        const scrollX = x - container.clientWidth / 2 + (match.width * currentScale) / 2;
        const scrollY = y - container.clientHeight / 2 + (match.height * currentScale) / 2;

        container.scrollTo({
          left: Math.max(0, scrollX),
          top: Math.max(0, scrollY),
          behavior: 'smooth'
        });
      }
    }
  }, [selectedDesignator, matches]);

  const searchAndHighlight = async (page: pdfjsLib.PDFPageProxy, viewport: pdfjsLib.PageViewport, searchTerms: string[], color: string = 'red', isSelection: boolean = false) => {
    const textContent = await page.getTextContent();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const foundMatches: MatchResult[] = [];
    
    const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Allow optional letter suffix (e.g., Q0301 matching Q0301A, Q0301B, etc.)
    const regexes = searchTerms.map(term => new RegExp(`\\b${escapeRegExp(term)}[A-Za-z]*\\b`, 'i'));

    textContent.items.forEach((item: any) => {
      if ('str' in item) {
        const matchIdx = regexes.findIndex((regex, idx) => regex.test(item.str) || item.str === searchTerms[idx]);
        if (matchIdx !== -1) {
          const tx = pdfjsLib.Util.transform(
            pdfjsLib.Util.transform(viewport.transform, item.transform),
            [1, 0, 0, -1, 0, 0]
          );

          // Draw highlight
          ctx.strokeStyle = color;
          ctx.lineWidth = isSelection ? 4 : 2;
          ctx.strokeRect(tx[4], tx[5] - item.height * scale, item.width * scale, item.height * scale);
          
          if (isSelection) {
            // Draw a semi-transparent fill for selection
            ctx.fillStyle = color + '22'; // 22 is ~13% opacity
            ctx.fillRect(tx[4], tx[5] - item.height * scale, item.width * scale, item.height * scale);
          }
          
          foundMatches.push({
            pageNumber: currentPage,
            viewport,
            transform: item.transform,
            width: item.width,
            height: item.height,
            text: item.str,
            color
          });
        }
      }
    });

    setMatches(prev => [...prev, ...foundMatches]);
  };

  const exportToExcel = () => {
    if (bomData.length === 0) return;

    const dataToExport = bomData.map(entry => ({
      "Part Reference": entry["Part Reference"],
      "Part Number": entry["Part Number"] || "",
      "Component Name": entry["Component_Name"] || "",
      "Status": componentStatuses[entry["Part Reference"]] || "Pending",
      "Optional": entry["Optional"] || ""
    }));

    const worksheet = XLSX.utils.json_to_sheet(dataToExport);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "BOM Status");
    XLSX.writeFile(workbook, `BOM_Status_Export_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const exportToPdf = async () => {
    if (!pdfDoc) return;

    setIsExporting(true);
    setExportProgress(0);

    // Get first page to initialize PDF with correct orientation/size
    const firstPage = await pdfDoc.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    
    const pdf = new jsPDF({
      orientation: firstViewport.width > firstViewport.height ? 'landscape' : 'portrait',
      unit: 'px',
      format: [firstViewport.width, firstViewport.height]
    });

    const confirmed = Object.keys(componentStatuses).filter(d => componentStatuses[d] === 'confirmed');
    const doubtful = Object.keys(componentStatuses).filter(d => componentStatuses[d] === 'doubtful');

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      setExportProgress(Math.round((i / pdfDoc.numPages) * 100));
      const page = await pdfDoc.getPage(i);
      const originalViewport = page.getViewport({ scale: 1 });
      const exportScale = 3; // Increased scale for better quality (3x is usually a good balance)
      const viewport = page.getViewport({ scale: exportScale });
      
      const tempCanvas = document.createElement('canvas');
      const tempCtx = tempCanvas.getContext('2d')!;
      tempCanvas.width = viewport.width;
      tempCanvas.height = viewport.height;

      // Set white background for the canvas (PDFs often have transparent backgrounds)
      tempCtx.fillStyle = '#FFFFFF';
      tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

      await page.render({
        canvasContext: tempCtx,
        viewport: viewport
      }).promise;

      // Draw highlights
      const textContent = await page.getTextContent();
      const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      const drawHighlights = (terms: string[], color: string) => {
        const regexes = terms.map(term => new RegExp(`\\b${escapeRegExp(term)}[A-Za-z]*\\b`, 'i'));
        textContent.items.forEach((item: any) => {
          if ('str' in item) {
            const matchIdx = regexes.findIndex((regex, idx) => regex.test(item.str) || item.str === terms[idx]);
            if (matchIdx !== -1) {
              const tx = pdfjsLib.Util.transform(
                pdfjsLib.Util.transform(viewport.transform, item.transform),
                [1, 0, 0, -1, 0, 0]
              );
              tempCtx.strokeStyle = color;
              tempCtx.lineWidth = 4 * (exportScale / 2); // Scale line width with export scale
              tempCtx.strokeRect(tx[4], tx[5] - item.height * exportScale, item.width * exportScale, item.height * exportScale);
              tempCtx.fillStyle = color + '22';
              tempCtx.fillRect(tx[4], tx[5] - item.height * exportScale, item.width * exportScale, item.height * exportScale);
            }
          }
        });
      };

      if (confirmed.length > 0) drawHighlights(confirmed, '#22c55e');
      if (doubtful.length > 0) drawHighlights(doubtful, '#ef4444');

      // Use PNG for better clarity on lines/text, or high-quality JPEG
      const imgData = tempCanvas.toDataURL('image/png');
      
      if (i > 1) {
        pdf.addPage([originalViewport.width, originalViewport.height], originalViewport.width > originalViewport.height ? 'l' : 'p');
      }
      
      pdf.addImage(imgData, 'PNG', 0, 0, originalViewport.width, originalViewport.height, undefined, 'FAST');
    }

    pdf.save(`Marked_BOM_PDF_${new Date().toISOString().slice(0, 10)}.pdf`);
    setIsExporting(false);
  };

  const selectedBomEntry = useMemo(() => {
    if (isComparing && comparisonResults && selectedDesignator) {
      const result = comparisonResults.find(r => r.designator === selectedDesignator);
      if (result) {
        return result.status === 'removed' ? result.bom1Entry : result.bom2Entry;
      }
    }
    return bomData.find(entry => entry["Part Reference"] === selectedDesignator);
  }, [bomData, selectedDesignator, isComparing, comparisonResults]);

  return (
    <div className={cn(
      "h-screen flex flex-col font-sans transition-colors duration-300 overflow-hidden",
      isDarkMode ? "bg-neutral-900 text-neutral-100 dark" : "bg-neutral-100 text-neutral-900"
    )}>
      {/* Header */}
      <header className={cn(
        "border-b px-6 py-4 flex items-center justify-between shadow-sm z-20 transition-colors",
        isDarkMode ? "bg-neutral-800 border-neutral-700" : "bg-white border-neutral-200"
      )}>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="bg-red-600 p-2 rounded-lg">
              <Search className="text-white w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Circuit Inspector</h1>
          </div>
          
          {/* Search Input */}
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className={cn("h-4 w-4", isDarkMode ? "text-neutral-400" : "text-neutral-500")} />
            </div>
            <input
              type="text"
              placeholder="Search designator (e.g. R123)"
              value={selectedDesignator || ""}
              onChange={(e) => setSelectedDesignator(e.target.value.toUpperCase() || null)}
              className={cn(
                "pl-10 pr-4 py-1.5 rounded-md border text-sm w-64 focus:outline-none focus:ring-2 focus:ring-red-500 transition-colors",
                isDarkMode 
                  ? "bg-neutral-900 border-neutral-700 text-neutral-100 placeholder-neutral-500" 
                  : "bg-neutral-100 border-neutral-300 text-neutral-900 placeholder-neutral-500"
              )}
            />
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          {pdfDoc && bomData.length > 0 && (
            <div className="flex items-center gap-2 mr-2 border-r pr-4 border-neutral-200 dark:border-neutral-700">
              <button
                onClick={exportToExcel}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                  isDarkMode ? "bg-neutral-700 hover:bg-neutral-600 text-neutral-200" : "bg-neutral-100 hover:bg-neutral-200 text-neutral-700"
                )}
                title="Export BOM with Status to Excel"
              >
                <Download className="w-3.5 h-3.5" />
                Excel
              </button>
              <button
                onClick={exportToPdf}
                disabled={isExporting}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                  isExporting ? "opacity-50 cursor-not-allowed" : "",
                  isDarkMode ? "bg-red-900/30 hover:bg-red-900/50 text-red-400" : "bg-red-50 hover:bg-red-100 text-red-600"
                )}
                title="Export Marked PDF with Highlights"
              >
                {isExporting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    {exportProgress}%
                  </>
                ) : (
                  <>
                    <Download className="w-3.5 h-3.5" />
                    Marked PDF
                  </>
                )}
              </button>
            </div>
          )}
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)}
            className={cn(
              "p-2 rounded-full transition-colors",
              isDarkMode ? "bg-neutral-700 text-yellow-400 hover:bg-neutral-600" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
            )}
            title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
          >
            {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>

          <label className={cn(
            "flex items-center gap-2 cursor-pointer border px-3 py-1.5 rounded-md transition-colors text-sm font-medium",
            isDarkMode ? "bg-neutral-700 border-neutral-600 hover:bg-neutral-600 text-neutral-200" : "bg-white border-neutral-300 hover:bg-neutral-50 text-neutral-700"
          )}>
            <Upload className="w-4 h-4" />
            Upload PDF
            <input type="file" accept=".pdf" className="hidden" onChange={handlePdfUpload} />
          </label>
          <label className={cn(
            "flex items-center gap-2 cursor-pointer border px-3 py-1.5 rounded-md transition-colors text-sm font-medium",
            isDarkMode ? "bg-neutral-700 border-neutral-600 hover:bg-neutral-600 text-neutral-200" : "bg-white border-neutral-300 hover:bg-neutral-50 text-neutral-700"
          )}>
            <FileText className="w-4 h-4" />
            Upload BOM (CSV/TXT)
            <input type="file" accept=".csv,.txt,.xlsx,.xls" className="hidden" onChange={handleBomUpload} multiple />
          </label>
          
          <button 
            onClick={() => setShowDebugModal(true)}
            className={cn(
              "flex items-center gap-2 border px-3 py-1.5 rounded-md transition-colors text-sm font-medium",
              isDarkMode ? "bg-neutral-700 border-neutral-600 hover:bg-neutral-600 text-neutral-200" : "bg-white border-neutral-300 hover:bg-neutral-50 text-neutral-700"
            )}
            title="Debug BOM Data"
          >
            <Bug className="w-4 h-4 text-emerald-500" />
            Debug BOM
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Left Sidebar - BOM Components */}
        <div className={cn(
          "w-80 flex flex-col border-r transition-colors shrink-0",
          isDarkMode ? "bg-neutral-900 border-neutral-800" : "bg-white border-neutral-200"
        )}>
          <div className={cn(
            "p-4 border-b flex items-center justify-between",
            isDarkMode ? "border-neutral-800 bg-neutral-800/50" : "border-neutral-200 bg-neutral-50"
          )}>
            <h2 className={cn(
              "font-semibold flex items-center gap-2",
              isDarkMode ? "text-neutral-200" : "text-neutral-800"
            )}>
              <FileText className="w-4 h-4" />
              COMPONENTS
            </h2>
            <span className={cn(
              "text-xs px-2 py-0.5 rounded-full font-medium",
              isDarkMode ? "bg-neutral-800 text-neutral-300" : "bg-neutral-200 text-neutral-700"
            )}>
              {bomData.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {isComparing ? (
              <div className="space-y-4">
                <div className={cn(
                  "p-3 rounded-md border flex flex-col gap-2",
                  isDarkMode ? "bg-red-900/10 border-red-800/30" : "bg-red-50 border-red-100"
                )}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase text-red-500">Comparison Mode</span>
                    <button 
                      onClick={() => {
                        setIsComparing(false);
                        setComparisonResults(null);
                        setCompareWithBom(null);
                        setMatches([]);
                      }}
                      className="text-xs underline hover:text-red-600"
                    >
                      Exit
                    </button>
                  </div>
                  <p className="text-[10px] opacity-70">
                    Comparing <span className="font-bold">{activeBom}</span> with <span className="font-bold">{compareWithBom}</span>
                  </p>
                  <div className="flex gap-2 mt-1">
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="text-[10px]">Added</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-full bg-red-500" />
                      <span className="text-[10px]">Removed</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-full bg-amber-500" />
                      <span className="text-[10px]">Modified</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-1">
                  {comparisonResults?.filter(r => r.status !== 'identical').map((result, idx) => (
                    <div 
                      key={idx}
                      onClick={() => setSelectedDesignator(result.designator)}
                      className={cn(
                        "p-2 rounded-md border text-xs cursor-pointer transition-all hover:translate-x-1",
                        selectedDesignator === result.designator 
                          ? (isDarkMode ? "bg-neutral-700 border-neutral-500" : "bg-neutral-100 border-neutral-300 shadow-sm")
                          : (isDarkMode ? "bg-neutral-800/50 border-neutral-800" : "bg-white border-neutral-200"),
                        result.status === 'added' && "border-l-4 border-l-green-500",
                        result.status === 'removed' && "border-l-4 border-l-red-500",
                        result.status === 'modified' && "border-l-4 border-l-amber-500"
                      )}
                    >
                      <div className="flex justify-between items-start">
                        <span className="font-bold">{result.designator}</span>
                        <span className={cn(
                          "text-[9px] px-1 rounded uppercase font-bold",
                          result.status === 'added' && "bg-green-500/20 text-green-500",
                          result.status === 'removed' && "bg-red-500/20 text-red-500",
                          result.status === 'modified' && "bg-amber-500/20 text-amber-500"
                        )}>
                          {result.status}
                        </span>
                      </div>
                      {result.status === 'modified' && (
                        <div className="mt-1 text-[9px] opacity-60 italic">
                          Diff: {result.diffFields.join(', ')}
                        </div>
                      )}
                      {result.status === 'added' && result.bom2Entry?.["Part Number"] && (
                        <div className="mt-1 text-[9px] opacity-60">PN: {result.bom2Entry["Part Number"]}</div>
                      )}
                      {result.status === 'removed' && result.bom1Entry?.["Part Number"] && (
                        <div className="mt-1 text-[9px] opacity-60">PN: {result.bom1Entry["Part Number"]}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {Object.keys(bomFiles).length > 1 && (
                  <button 
                    onClick={() => {
                      const otherBom = Object.keys(bomFiles).find(name => name !== activeBom);
                      if (activeBom && otherBom) {
                        handleCompare(otherBom, activeBom); // otherBom is old, activeBom is new
                      }
                    }}
                    className={cn(
                      "w-full p-2 rounded-md border text-sm font-bold mb-4 flex items-center justify-center gap-2",
                      isDarkMode ? "bg-red-900/30 border-red-800 text-red-400 hover:bg-red-900/40" : "bg-red-100 border-red-200 text-red-700 hover:bg-red-200"
                    )}
                  >
                    <AlertCircle className="w-4 h-4" />
                    Compare BOMs
                  </button>
                )}
                <div className={cn(
                  "p-3 rounded-md border flex flex-col gap-2 mb-4",
                  isDarkMode ? "bg-neutral-800/50 border-neutral-700" : "bg-neutral-50 border-neutral-200"
                )}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-bold uppercase text-neutral-500">Status Legend</span>
                    {Object.keys(componentStatuses).length > 0 && (
                      <button 
                        onClick={() => setComponentStatuses({})}
                        className="text-[9px] underline hover:text-red-500 transition-colors"
                      >
                        Clear All
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="text-[10px] flex items-center gap-1">
                        Confirmed 
                        <kbd className="px-1.5 py-0.5 rounded border border-neutral-400 dark:border-neutral-500 bg-neutral-200 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 text-[9px] font-mono leading-none shadow-sm">C</kbd>
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-red-500" />
                      <span className="text-[10px] flex items-center gap-1">
                        Doubtful 
                        <kbd className="px-1.5 py-0.5 rounded border border-neutral-400 dark:border-neutral-500 bg-neutral-200 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 text-[9px] font-mono leading-none shadow-sm">D</kbd>
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      <span className="text-[10px]">Selected</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] flex items-center gap-1 text-neutral-400">
                        Clear 
                        <kbd className="px-1.5 py-0.5 rounded border border-neutral-400 dark:border-neutral-500 bg-neutral-200 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 text-[9px] font-mono leading-none shadow-sm">X</kbd>
                      </span>
                    </div>
                  </div>
                </div>

                {Object.keys(bomFiles).length > 0 && (
                  <div className="mb-4">
                    <label className="text-xs font-bold uppercase text-neutral-500">Active BOM</label>
                    <select 
                      value={activeBom || ""} 
                      onChange={(e) => setActiveBom(e.target.value)}
                      className={cn(
                        "w-full p-2 rounded-md border text-sm",
                        isDarkMode ? "bg-neutral-800 border-neutral-700 text-neutral-200" : "bg-white border-neutral-300 text-neutral-800"
                      )}
                    >
                      {Object.keys(bomFiles).map(name => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </div>
                )}
                {bomData.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-neutral-400 py-12 text-center">
                    <FileText className="w-12 h-12 mb-4 opacity-20" />
                    <p className="text-sm">No components loaded.</p>
                    <p className="text-xs mt-1 opacity-70">Upload a BOM file to see the list here.</p>
                  </div>
                ) : (
                  groupedBomData.map((group) => {
                    const isGroupSelected = selectedGroup === group.page;
                    const isExpanded = expandedGroups.has(group.page);
                    
                    return (
                      <div key={group.page} className="mb-3">
                        <div 
                          onClick={() => {
                            setExpandedGroups(prev => {
                              const next = new Set(prev);
                              if (next.has(group.page)) next.delete(group.page);
                              else next.add(group.page);
                              return next;
                            });
                            setSelectedGroup(group.page);
                            setSelectedDesignator(null);
                          }}
                          className={cn(
                            "flex items-center justify-between p-2 rounded-md cursor-pointer transition-colors border",
                            isGroupSelected 
                              ? (isDarkMode ? "bg-red-900/30 border-red-800 text-red-400" : "bg-red-100 border-red-300 text-red-700")
                              : (isDarkMode ? "bg-neutral-800 border-neutral-700 hover:bg-neutral-700" : "bg-neutral-100 border-neutral-200 hover:bg-neutral-200")
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <ChevronDown className={cn("w-4 h-4 transition-transform", isExpanded ? "" : "-rotate-90")} />
                            <span className="font-bold text-sm">
                              {group.page === 9999 ? "Other Components" : `Page ${group.page}`}
                            </span>
                          </div>
                          <span className="text-xs opacity-70 font-mono bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded">
                            {group.entries.length}
                          </span>
                        </div>
                        
                        {isExpanded && (
                          <div className="mt-2 pl-2 space-y-2 border-l-2 border-neutral-200 dark:border-neutral-800 ml-3">
                            {group.entries.map((item, idx) => {
                              const isSelected = selectedDesignator === item["Part Reference"];
                              return (
                                <div 
                                  key={idx} 
                                  id={`bom-item-${item["Part Reference"]}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedDesignator(item["Part Reference"]);
                                    setSelectedGroup(null);
                                  }}
                                  className={cn(
                                    "p-3 rounded-md border text-sm cursor-pointer transition-all hover:shadow-sm",
                                    isSelected 
                                      ? (isDarkMode ? "bg-red-900/20 border-red-800 shadow-inner" : "bg-red-50 border-red-200 shadow-inner")
                                      : (isDarkMode ? "bg-neutral-800/50 border-neutral-800 hover:bg-neutral-700" : "bg-white border-neutral-200 hover:border-neutral-300"),
                                    componentStatuses[item["Part Reference"]] === 'confirmed' && "border-l-4 border-l-green-500",
                                    componentStatuses[item["Part Reference"]] === 'doubtful' && "border-l-4 border-l-red-500"
                                  )}
                                >
                                  <div className="flex justify-between items-start mb-2 gap-2">
                                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                                      <span className={cn(
                                        "font-bold truncate",
                                        isSelected ? "text-red-500" : (isDarkMode ? "text-neutral-200" : "text-neutral-800")
                                      )}>
                                        {item["Part Reference"]}
                                      </span>
                                      {componentStatuses[item["Part Reference"]] && (
                                        <span className={cn(
                                          "text-[8px] px-1 py-0.5 rounded font-bold uppercase shrink-0",
                                          componentStatuses[item["Part Reference"]] === 'confirmed' 
                                            ? (isDarkMode ? "bg-green-900/40 text-green-400" : "bg-green-100 text-green-700")
                                            : (isDarkMode ? "bg-red-900/40 text-red-400" : "bg-red-100 text-red-700")
                                        )}>
                                          {componentStatuses[item["Part Reference"]]}
                                        </span>
                                      )}
                                      {item["Optional"] && (
                                        <span className={cn(
                                          "text-[8px] px-1 py-0.5 rounded font-medium uppercase tracking-wider shrink-0",
                                          isDarkMode ? "bg-amber-900/30 text-amber-400" : "bg-amber-100 text-amber-700"
                                        )}>
                                          {item["Optional"]}
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <button 
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setComponentStatuses(prev => {
                                            if (prev[item["Part Reference"]] === 'confirmed') {
                                              const next = {...prev};
                                              delete next[item["Part Reference"]];
                                              return next;
                                            }
                                            return {...prev, [item["Part Reference"]]: 'confirmed'};
                                          });
                                        }}
                                        className={cn(
                                          "p-1 rounded transition-all",
                                          componentStatuses[item["Part Reference"]] === 'confirmed'
                                            ? "bg-green-500 text-white shadow-sm"
                                            : (isDarkMode ? "text-neutral-600 hover:text-green-500 hover:bg-neutral-700" : "text-neutral-300 hover:text-green-600 hover:bg-neutral-100")
                                        )}
                                        title="Confirm"
                                      >
                                        <Check className="w-3 h-3" />
                                      </button>
                                      <button 
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setComponentStatuses(prev => {
                                            if (prev[item["Part Reference"]] === 'doubtful') {
                                              const next = {...prev};
                                              delete next[item["Part Reference"]];
                                              return next;
                                            }
                                            return {...prev, [item["Part Reference"]]: 'doubtful'};
                                          });
                                        }}
                                        className={cn(
                                          "p-1 rounded transition-all",
                                          componentStatuses[item["Part Reference"]] === 'doubtful'
                                            ? "bg-red-500 text-white shadow-sm"
                                            : (isDarkMode ? "text-neutral-600 hover:text-red-500 hover:bg-neutral-700" : "text-neutral-300 hover:text-red-600 hover:bg-neutral-100")
                                        )}
                                        title="Doubt"
                                      >
                                        <AlertCircle className="w-3 h-3" />
                                      </button>
                                    </div>
                                  </div>
                                  <div className="grid grid-cols-1 gap-1 text-xs">
                                    <div className="flex justify-between items-center gap-2">
                                      <span className={cn("shrink-0", isDarkMode ? "text-neutral-500" : "text-neutral-400")}>PN:</span>
                                      <span className={cn("font-mono truncate", isDarkMode ? "text-neutral-300" : "text-neutral-600")}>
                                        {item["Part Number"] || '-'}
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center gap-2">
                                      <span className={cn("shrink-0", isDarkMode ? "text-neutral-500" : "text-neutral-400")}>Name:</span>
                                      <span className={cn("truncate", isDarkMode ? "text-neutral-300" : "text-neutral-600")} title={item["Component_Name"]}>
                                        {item["Component_Name"] || '-'}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </>
            )}
          </div>
        </div>

        {/* PDF Viewer Area */}
        <div className={cn(
          "flex-1 flex flex-col relative overflow-hidden transition-colors",
          isDarkMode ? "bg-neutral-900" : "bg-neutral-200"
        )}>
          {/* Minimap Overlay */}
          {pdfDoc && showMinimap && (
            <div className={cn(
              "absolute bottom-6 left-6 p-2 rounded-lg border shadow-xl z-30 transition-all duration-300 animate-in fade-in zoom-in-95",
              isDarkMode ? "bg-neutral-800 border-neutral-700" : "bg-white border-neutral-200"
            )}>
              <div className="flex items-center justify-between mb-2 px-1">
                <div className="flex items-center gap-1.5 opacity-60">
                  <Map className="w-3 h-3" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">Navigator</span>
                </div>
                <button 
                  onClick={() => setShowMinimap(false)} 
                  className={cn(
                    "p-0.5 rounded-full transition-colors",
                    isDarkMode ? "hover:bg-neutral-700" : "hover:bg-neutral-100"
                  )}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div 
                className="relative cursor-pointer overflow-hidden rounded bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700"
                onClick={handleMinimapClick}
              >
                <canvas ref={minimapCanvasRef} className="block" />
                {/* Viewport Highlight */}
                <div 
                  className="absolute border-2 border-red-500 bg-red-500/10 pointer-events-none transition-all duration-75"
                  style={{
                    top: `${viewportRect.top}%`,
                    left: `${viewportRect.left}%`,
                    width: `${Math.min(100, viewportRect.width)}%`,
                    height: `${Math.min(100, viewportRect.height)}%`
                  }}
                />
              </div>
            </div>
          )}
          
          {/* Minimap Toggle (if hidden) */}
          {pdfDoc && !showMinimap && (
            <button 
              onClick={() => setShowMinimap(true)}
              title="Show Navigator"
              className={cn(
                "absolute bottom-6 left-6 p-2 rounded-full border shadow-lg z-30 transition-all hover:scale-110",
                isDarkMode ? "bg-neutral-800 border-neutral-700 text-neutral-400" : "bg-white border-neutral-200 text-neutral-500"
              )}
            >
              <Map className="w-4 h-4" />
            </button>
          )}

          {/* Toolbar */}
          <div className={cn(
            "backdrop-blur-md border-b p-2 flex items-center justify-between z-10 transition-colors",
            isDarkMode ? "bg-neutral-800/80 border-neutral-700 text-neutral-200" : "bg-white/80 border-neutral-200 text-neutral-800"
          )}>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage <= 1}
                className={cn(
                  "p-1.5 rounded disabled:opacity-30 transition-colors",
                  isDarkMode ? "hover:bg-neutral-700" : "hover:bg-neutral-200"
                )}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-1 text-sm font-medium px-2">
                <span>Page</span>
                <input
                  type="number"
                  min={1}
                  max={numPages || 1}
                  value={pageInputValue}
                  onChange={(e) => setPageInputValue(e.target.value)}
                  onBlur={handlePageInputSubmit}
                  onKeyDown={(e) => e.key === 'Enter' && handlePageInputSubmit()}
                  className={cn(
                    "w-12 text-center rounded border py-0.5 outline-none transition-colors",
                    isDarkMode 
                      ? "bg-neutral-900 border-neutral-700 focus:border-red-500 text-neutral-200" 
                      : "bg-white border-neutral-300 focus:border-red-500 text-neutral-800"
                  )}
                />
                <span>of {numPages || '?'}</span>
              </div>
              <button 
                onClick={() => setCurrentPage(prev => Math.min(numPages, prev + 1))}
                disabled={currentPage >= numPages}
                className={cn(
                  "p-1.5 rounded disabled:opacity-30 transition-colors",
                  isDarkMode ? "hover:bg-neutral-700" : "hover:bg-neutral-200"
                )}
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button 
                onClick={() => setScale(s => Math.max(0.5, s - 0.25))} 
                className={cn(
                  "p-1.5 rounded transition-colors",
                  isDarkMode ? "hover:bg-neutral-700" : "hover:bg-neutral-200"
                )}
              >
                <ZoomOut className="w-5 h-5" />
              </button>
              <span className="text-sm font-medium w-12 text-center">{Math.round(scale * 100)}%</span>
              <button 
                onClick={() => setScale(s => Math.min(5, s + 0.25))} 
                className={cn(
                  "p-1.5 rounded transition-colors",
                  isDarkMode ? "hover:bg-neutral-700" : "hover:bg-neutral-200"
                )}
              >
                <ZoomIn className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Canvas Container */}
          <div 
            className="flex-1 overflow-auto p-8 text-center" 
            ref={containerRef}
          >
            {isLoading ? (
              <div className="inline-flex flex-col items-center justify-center h-full text-neutral-500">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600 mb-4"></div>
                <p>Loading schematic...</p>
              </div>
            ) : pdfDoc ? (
              <div className={cn(
                "inline-block relative shadow-2xl transition-all duration-500 text-left align-middle",
                isDarkMode ? "bg-neutral-800 ring-1 ring-neutral-700" : "bg-white"
              )}>
                <canvas 
                  ref={canvasRef} 
                  className="block cursor-crosshair" 
                  onClick={handleCanvasClick}
                />
              </div>
            ) : (
              <div className="inline-flex flex-col items-center justify-center h-full text-neutral-400 max-w-md text-center">
                <Search className="w-16 h-16 mb-4 opacity-10" />
                <h3 className={cn(
                  "text-lg font-semibold mb-2",
                  isDarkMode ? "text-neutral-500" : "text-neutral-600"
                )}>No Schematic Loaded</h3>
                <p className="text-sm">Upload a circuit diagram PDF to start inspecting your components.</p>
              </div>
            )}
          </div>

          {/* Info Panel Overlay */}
          {selectedDesignator && (
            <div className={cn(
              "absolute bottom-6 right-6 w-80 shadow-2xl rounded-xl border overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300 z-30 transition-colors",
              isDarkMode ? "bg-neutral-800 border-neutral-700" : "bg-white border-neutral-200"
            )}>
              <div className="bg-red-600 p-4 text-white flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Info className="w-5 h-5" />
                  <span className="font-bold tracking-tight">{selectedDesignator}</span>
                  {isComparing && comparisonResults && (
                    <span className={cn(
                      "text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ml-2 border border-white/30",
                      comparisonResults.find(r => r.designator === selectedDesignator)?.status === 'added' && "bg-green-500",
                      comparisonResults.find(r => r.designator === selectedDesignator)?.status === 'removed' && "bg-red-500",
                      comparisonResults.find(r => r.designator === selectedDesignator)?.status === 'modified' && "bg-amber-500"
                    )}>
                      {comparisonResults.find(r => r.designator === selectedDesignator)?.status}
                    </span>
                  )}
                </div>
                <button onClick={() => setSelectedDesignator(null)} className="hover:bg-red-700 p-1 rounded">
                  <ChevronRight className="w-4 h-4 rotate-90" />
                </button>
              </div>
              <div className="p-4 space-y-3">
                {selectedBomEntry ? (
                  <>
                    {selectedBomEntry.originalLine && (
                      <div className="space-y-1">
                        <label className={cn(
                          "text-[10px] uppercase font-bold tracking-wider",
                          isDarkMode ? "text-neutral-500" : "text-neutral-400"
                        )}>Source Line (L{selectedBomEntry.lineNumber})</label>
                        <p className={cn(
                          "text-xs font-mono break-words p-2 rounded",
                          isDarkMode ? "bg-neutral-900 text-neutral-300" : "bg-neutral-50 text-neutral-600"
                        )}>{selectedBomEntry.originalLine}</p>
                      </div>
                    )}
                    {Object.entries(selectedBomEntry).map(([key, value]) => (
                      !['Part Reference', 'originalLine', 'lineNumber'].includes(key) && value && (
                        <div key={key} className="space-y-1">
                          <label className={cn(
                            "text-[10px] uppercase font-bold tracking-wider",
                            isDarkMode ? "text-neutral-500" : "text-neutral-400"
                          )}>{key}</label>
                          <p className={cn(
                            "text-sm break-words",
                            isDarkMode ? "text-neutral-200" : "text-neutral-800"
                          )}>{String(value)}</p>
                        </div>
                      )
                    ))}
                  </>
                ) : (
                  <div className={cn(
                    "flex items-center gap-2 p-3 rounded-lg",
                    isDarkMode ? "text-amber-400 bg-amber-900/20" : "text-amber-600 bg-amber-50"
                  )}>
                    <AlertCircle className="w-4 h-4" />
                    <p className="text-xs font-medium">Component not found in BOM data.</p>
                  </div>
                )}
                
                <div className={cn(
                  "pt-2 border-t",
                  isDarkMode ? "border-neutral-700" : "border-neutral-100"
                )}>
                  <div className="flex gap-2 mb-3">
                    <button 
                      onClick={() => setComponentStatuses(prev => ({...prev, [selectedDesignator]: 'confirmed'}))}
                      className={cn(
                        "flex-1 py-1.5 rounded text-[10px] font-bold uppercase transition-all",
                        componentStatuses[selectedDesignator] === 'confirmed' 
                          ? "bg-green-600 text-white shadow-lg scale-105" 
                          : (isDarkMode ? "bg-neutral-700 text-neutral-400 hover:bg-neutral-600" : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200")
                      )}
                    >
                      Confirm
                    </button>
                    <button 
                      onClick={() => setComponentStatuses(prev => ({...prev, [selectedDesignator]: 'doubtful'}))}
                      className={cn(
                        "flex-1 py-1.5 rounded text-[10px] font-bold uppercase transition-all",
                        componentStatuses[selectedDesignator] === 'doubtful' 
                          ? "bg-red-600 text-white shadow-lg scale-105" 
                          : (isDarkMode ? "bg-neutral-700 text-neutral-400 hover:bg-neutral-600" : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200")
                      )}
                    >
                      Doubt
                    </button>
                    <button 
                      onClick={() => setComponentStatuses(prev => {
                        const next = {...prev};
                        delete next[selectedDesignator];
                        return next;
                      })}
                      className={cn(
                        "flex-1 py-1.5 rounded text-[10px] font-bold uppercase transition-all",
                        !componentStatuses[selectedDesignator] 
                          ? (isDarkMode ? "bg-neutral-600 text-white" : "bg-neutral-300 text-neutral-700")
                          : (isDarkMode ? "bg-neutral-700 text-neutral-400 hover:bg-neutral-600" : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200")
                      )}
                    >
                      Reset
                    </button>
                  </div>
                  <p className="text-[10px] text-neutral-400 italic">
                    {matches.length > 0 
                      ? `Found ${matches.length} instance(s) on this page.`
                      : "Searching for component on this page..."}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Debug Modal */}
      {showDebugModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className={cn(
            "w-full max-w-4xl max-h-[80vh] flex flex-col rounded-xl shadow-2xl overflow-hidden",
            isDarkMode ? "bg-neutral-900 border border-neutral-700" : "bg-white border border-neutral-200"
          )}>
            <div className={cn(
              "flex items-center justify-between p-4 border-b",
              isDarkMode ? "border-neutral-700 bg-neutral-800" : "border-neutral-200 bg-neutral-50"
            )}>
              <div className="flex items-center gap-2">
                <Bug className="w-5 h-5 text-emerald-500" />
                <h2 className="font-bold">BOM Data Debugger</h2>
                <span className={cn(
                  "text-xs px-2 py-0.5 rounded-full",
                  isDarkMode ? "bg-neutral-700 text-neutral-300" : "bg-neutral-200 text-neutral-700"
                )}>
                  {bomData.length} entries
                </span>
              </div>
              <button 
                onClick={() => setShowDebugModal(false)}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  isDarkMode ? "hover:bg-neutral-700" : "hover:bg-neutral-200"
                )}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {bomData.length > 0 ? (
                <pre className={cn(
                  "text-xs font-mono p-4 rounded-lg overflow-x-auto",
                  isDarkMode ? "bg-neutral-950 text-emerald-400" : "bg-neutral-100 text-emerald-700"
                )}>
                  {JSON.stringify(bomData, null, 2)}
                </pre>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-neutral-400 py-12">
                  <FileText className="w-12 h-12 mb-4 opacity-20" />
                  <p>No BOM data loaded yet.</p>
                  <p className="text-sm mt-2 opacity-70">Upload a CSV or TXT file to see the parsed data here.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Error Message Overlay */}
      {error && (
        <div className="fixed bottom-6 right-6 bg-red-600 text-white px-6 py-3 rounded-full shadow-lg flex items-center gap-3 z-[100] animate-bounce">
          <AlertCircle className="w-5 h-5" />
          <span className="text-sm font-medium">{error}</span>
          <button onClick={() => setError(null)} className="ml-2 hover:bg-red-700 rounded-full p-1">
            <ChevronRight className="w-4 h-4 rotate-90" />
          </button>
        </div>
      )}
    </div>
  );
}
