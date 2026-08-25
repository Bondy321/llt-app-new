/**
 * Tours Manager Component
 *
 * A comprehensive tour management system that integrates with Firebase Realtime Database.
 * Matches the existing Firebase tour data structure.
 *
 * FIREBASE DATA STRUCTURE:
 * ========================
 * tours/{tourId}:
 *   - name: string
 *   - tourCode: string (e.g., "5209L 16")
 *   - days: number
 *   - startDate: string (DD/MM/YYYY)
 *   - endDate: string (DD/MM/YYYY)
 *   - isActive: boolean
 *   - driverName: string ("TBA" or driver name)
 *   - driverPhone: string
 *   - maxParticipants: number
 *   - currentParticipants: number
 *   - pickupPoints: [{location, time}]
 *   - itinerary: {title, days: [{day, title, activities: [{description, time}]}]}
 *
 * HOW TO ADD A NEW TOUR:
 * =====================
 * Method 1: Click "Add Tour" button to open the creation modal
 * Method 2: Use "Quick Create" with pre-defined templates
 * Method 3: Import tours from CSV file
 */

import { useState } from 'react';
import { notifications } from '@mantine/notifications';
import { Text, Group, Button, Select, Stack, Badge, Table, ScrollArea, Modal, Paper, ThemeIcon, Tabs, Alert, FileButton, Code, Switch } from '@mantine/core';
import { IconDownload, IconUpload, IconAlertCircle, IconCircleCheck, IconInfoCircle, IconDatabaseExport } from '@tabler/icons-react';
import { exportToursToCSV, previewTourCSVImport, executeTourCSVImport } from '../../../services/tourService';
import { getCurrentISODateStamp } from '../../../utils/dateUtils';
// Tour Card Component for grid view
export function ImportExportModal({
  opened,
  onClose,
  tours,
  drivers,
  onImportSuccess,
  dateScope
}) {
  const [activeTab, setActiveTab] = useState('export');
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState('upsert');
  const [importValidOnly, setImportValidOnly] = useState(true);
  const [importPreview, setImportPreview] = useState({
    rows: [],
    parseErrors: [],
    summary: {
      total: 0,
      valid: 0,
      invalid: 0
    }
  });
  const [rawCsvContent, setRawCsvContent] = useState('');
  const handleExport = () => {
    const csv = exportToursToCSV(tours, {
      drivers
    });
    const blob = new Blob([csv], {
      type: 'text/csv;charset=utf-8;'
    });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `tours_export_${getCurrentISODateStamp()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    notifications.show({
      title: 'Export Complete',
      message: `${Object.keys(tours).length} tours exported to CSV`,
      color: 'green'
    });
  };
  const handleFileSelect = file => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const content = String(e.target?.result || '');
        setRawCsvContent(content);
        const preview = await previewTourCSVImport(content, {
          mode: importMode
        });
        setImportPreview(preview);
      } catch (error) {
        notifications.show({
          title: 'Parse Error',
          message: error.message || 'Could not parse the CSV file. Please check the format.',
          color: 'red'
        });
      }
    };
    reader.readAsText(file);
  };
  const handleImport = async () => {
    if (importPreview.summary.total === 0) {
      notifications.show({
        title: 'No Data',
        message: 'Please select a CSV file with tour data',
        color: 'red'
      });
      return;
    }
    if (importValidOnly && importPreview.summary.valid === 0) {
      notifications.show({
        title: 'No Valid Rows',
        message: 'No valid rows available to import.',
        color: 'red'
      });
      return;
    }
    setImporting(true);
    try {
      const result = await executeTourCSVImport(importPreview.rows, {
        mode: importMode,
        importValidOnly,
        createdBy: 'import'
      });
      notifications.show({
        title: 'Import Complete',
        message: result.errors.length > 0 ? `Created ${result.created.length}, updated ${result.updated.length}, failed ${result.errors.length}. First issue: ${result.errors[0].error}` : `Created ${result.created.length}, updated ${result.updated.length}, failed 0`,
        color: result.errors.length > 0 ? 'orange' : 'green'
      });
      onImportSuccess();
      setImportPreview({
        rows: [],
        parseErrors: [],
        summary: {
          total: 0,
          valid: 0,
          invalid: 0
        }
      });
      setRawCsvContent('');
      onClose();
    } catch (error) {
      notifications.show({
        title: 'Import Error',
        message: error.message,
        color: 'red'
      });
    } finally {
      setImporting(false);
    }
  };
  const handleModeChange = async mode => {
    setImportMode(mode);
    if (!rawCsvContent) return;
    const preview = await previewTourCSVImport(rawCsvContent, {
      mode
    });
    setImportPreview(preview);
  };
  const rowsToShow = importPreview.rows.slice(0, 25);
  return <Modal opened={opened} onClose={onClose} title={<Group gap="xs">
          <ThemeIcon color="brand" variant="light" size="md">
            <IconDatabaseExport size={16} />
          </ThemeIcon>
          <Text fw={600}>Import / Export Tours</Text>
        </Group>} size="xl" centered>
      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="export" leftSection={<IconDownload size={14} />}>
            Export
          </Tabs.Tab>
          <Tabs.Tab value="import" leftSection={<IconUpload size={14} />}>
            Import
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="export">
          <Stack gap="md">
            <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
              Export the tours currently loaded in the {dateScope} date view. This is a bounded operational export, not an automatic full-archive backup.
            </Alert>

            <Paper p="md" radius="md" withBorder>
              <Group justify="space-between">
                <div>
                  <Text fw={500}>Ready to Export</Text>
                  <Text size="sm" c="dimmed">{Object.keys(tours).length} tours will be exported</Text>
                </div>
                <ThemeIcon color="green" variant="light" size="xl" radius="md">
                  <IconCircleCheck size={24} />
                </ThemeIcon>
              </Group>
            </Paper>

            <Button leftSection={<IconDownload size={16} />} onClick={handleExport} fullWidth>
              Download CSV File
            </Button>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="import">
          <Stack gap="md">
            <Alert icon={<IconInfoCircle size={16} />} color="orange" variant="light">
              Import tours from CSV with validation preview. Required columns: Tour Code and Name.
            </Alert>

            <Select label="Import mode" value={importMode} onChange={value => value && handleModeChange(value)} data={[{
            value: 'create-only',
            label: 'Create only (reject existing tour codes)'
          }, {
            value: 'update-existing',
            label: 'Update existing only (reject new tour codes)'
          }, {
            value: 'upsert',
            label: 'Upsert (create new and update existing)'
          }]} />

            <FileButton onChange={handleFileSelect} accept=".csv">
              {props => <Paper {...props} p="xl" radius="md" withBorder style={{
              cursor: 'pointer',
              textAlign: 'center'
            }}>
                  <ThemeIcon color="brand" variant="light" size="xl" radius="xl" mx="auto" mb="sm">
                    <IconUpload size={24} />
                  </ThemeIcon>
                  <Text fw={500}>Click to select CSV file</Text>
                  <Text size="xs" c="dimmed">Supports quoted multiline and escaped quote fields</Text>
                </Paper>}
            </FileButton>

            {(importPreview.parseErrors.length > 0 || importPreview.summary.total > 0) && <Paper p="md" radius="md" withBorder>
                <Group justify="space-between" mb="sm">
                  <Text fw={500}>Dry-run Preview</Text>
                  <Group gap="xs">
                    <Badge color="blue">{importPreview.summary.total} rows</Badge>
                    <Badge color="green">{importPreview.summary.valid} valid</Badge>
                    <Badge color="red">{importPreview.summary.invalid} invalid</Badge>
                    {importPreview.summary.warnings > 0 ? <Badge color="yellow">{importPreview.summary.warnings} warnings</Badge> : null}
                  </Group>
                </Group>

                {importPreview.parseErrors.map((error, index) => <Alert key={index} color="red" variant="light" mb="xs" icon={<IconAlertCircle size={16} />}>
                    {error}
                  </Alert>)}

                <ScrollArea h={260}>
                  <Table striped highlightOnHover size="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Row</Table.Th>
                        <Table.Th>Mode</Table.Th>
                        <Table.Th>Tour Code</Table.Th>
                        <Table.Th>Name</Table.Th>
                        <Table.Th>Status</Table.Th>
                        <Table.Th>Checks</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {rowsToShow.map(row => <Table.Tr key={row.rowNumber}>
                          <Table.Td>{row.rowNumber}</Table.Td>
                          <Table.Td><Badge size="xs" variant="light">{row.action}</Badge></Table.Td>
                          <Table.Td><Code>{row.tour.tourCode || '-'}</Code></Table.Td>
                          <Table.Td>{row.tour.name || '-'}</Table.Td>
                          <Table.Td>
                            <Badge color={row.isValid ? 'green' : 'red'} size="xs">{row.isValid ? 'Valid' : 'Invalid'}</Badge>
                          </Table.Td>
                          <Table.Td>
                            {[...row.errors, ...(row.warnings || [])].length === 0 ? '-' : [...row.errors, ...(row.warnings || [])].join(' ')}
                          </Table.Td>
                        </Table.Tr>)}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
                {importPreview.rows.length > rowsToShow.length && <Text size="xs" c="dimmed" mt="xs">Showing first {rowsToShow.length} of {importPreview.rows.length} rows.</Text>}
              </Paper>}

            <Switch checked={importValidOnly} onChange={event => setImportValidOnly(event.currentTarget.checked)} label="Import valid rows only" description="When enabled, invalid rows are skipped." />

            <Button leftSection={<IconUpload size={16} />} onClick={handleImport} loading={importing} fullWidth disabled={importPreview.summary.total === 0}>
              Run Import
            </Button>
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Modal>;
}

// Main Tours Manager Component
