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

import { Card, Text, Title, Group, Button, TextInput, Select, Stack, Box, Badge, Table, ScrollArea, ActionIcon, Tooltip, Center, Paper, ThemeIcon, Divider, Avatar, SimpleGrid, Pagination, SegmentedControl, Alert, Collapse, Code, Indicator } from '@mantine/core';
import { IconSearch, IconFilter, IconRefresh, IconMap, IconEdit, IconCheck, IconX, IconCalendar, IconUsers, IconPlus, IconTrash, IconUpload, IconTemplate, IconEye, IconAlertCircle, IconPlayerPlay, IconInfoCircle, IconDatabaseExport, IconChevronDown, IconChevronRight, IconUserPlus } from '@tabler/icons-react';
import AddPassengerModal from '../../../components/AddPassengerModal';
import { formatDateForDisplay } from '../../../utils/dateUtils';
// Tour Card Component for grid view
import { TourCard } from './TourCards';
import { CreateTourModal } from './CreateTourModal';
import { EditTourModal } from './EditTourModal';
import { DeleteTourModal, TourDetailsModal } from './TourManagementModals';
import { ImportExportModal } from './ImportExportModal';
export default function ToursManagerView(props) {
  const {
    activeTours,
    addPassengerModalOpened,
    assignedTours,
    closeAddPassengerModal,
    closeCreateModal,
    closeDeleteModal,
    closeDetailsModal,
    closeEditModal,
    closeImportExportModal,
    createModalOpened,
    currentPage,
    deleteModalOpened,
    detailsModalOpened,
    driverDirectoryAtLimit,
    drivers,
    editModalOpened,
    filterDateScope,
    filterStatus,
    filteredTours,
    handleAddPassenger,
    handleDateScopeChange,
    handleDelete,
    handleDuplicate,
    handleEdit,
    handleFilterStatusChange,
    handleIssueStatus,
    handlePassengerCreated,
    handleSearchTermChange,
    handleTourCreated,
    handleViewDetails,
    helpExpanded,
    importExportModalOpened,
    openCreateModal,
    openImportExportModal,
    packCoverageByTour,
    packOperationsByTour,
    packOperationsSnapshot,
    packStatusSnapshot,
    paginatedTours,
    searchTerm,
    selectedTour,
    selectedTourId,
    setCurrentPage,
    setHelpExpanded,
    setSelectedTourId,
    setViewMode,
    syncStatus,
    totalPages,
    totalParticipants,
    totalTours,
    tourWindow,
    tours,
    unassignedTours,
    updatingIssueId,
    viewMode
  } = props;
  return <Box>
      {/* Header */}
      <Group justify="space-between" mb="xl">
        <div>
          <Group gap="sm">
            <Title order={2}>Tours Management</Title>
            <Indicator color={syncStatus === 'connected' ? 'green' : syncStatus === 'syncing' ? 'orange' : 'red'} processing={syncStatus === 'syncing'}>
              <Tooltip label={`Firebase: ${syncStatus}`}>
                <ThemeIcon variant="light" color={syncStatus === 'connected' ? 'green' : 'orange'} size="sm">
                  <IconRefresh size={14} />
                </ThemeIcon>
              </Tooltip>
            </Indicator>
          </Group>
          <Text c="dimmed" size="sm">Create, edit, and manage tours with real-time Firebase sync</Text>
        </div>
        <Group gap="sm">
          <Button variant="light" leftSection={<IconDatabaseExport size={16} />} onClick={openImportExportModal}>
            Import/Export current date view
          </Button>
          <Button variant="light" leftSection={<IconUserPlus size={16} />} onClick={() => handleAddPassenger(null)}>
            Add Passenger
          </Button>
          <Button leftSection={<IconPlus size={16} />} onClick={openCreateModal}>
            Add Tour
          </Button>
        </Group>
      </Group>

      {/* How to Add Tours Help Section */}
      <Card shadow="sm" padding="md" radius="md" withBorder mb="lg">
        <Group justify="space-between" onClick={() => setHelpExpanded(!helpExpanded)} style={{
        cursor: 'pointer'
      }}>
          <Group gap="sm">
            <ThemeIcon color="blue" variant="light" size="md">
              <IconInfoCircle size={16} />
            </ThemeIcon>
            <div>
              <Text fw={500}>How to Add Tours to Firebase</Text>
              <Text size="xs" c="dimmed">Click to expand for instructions</Text>
            </div>
          </Group>
          <ActionIcon variant="subtle">
            {helpExpanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
          </ActionIcon>
        </Group>

        <Collapse in={helpExpanded}>
          <Divider my="md" />
          <SimpleGrid cols={{
          base: 1,
          md: 3
        }} spacing="md">
            <Paper p="md" radius="md" bg="green.0">
              <Group gap="xs" mb="sm">
                <ThemeIcon color="green" variant="light" size="md">
                  <IconPlus size={16} />
                </ThemeIcon>
                <Text fw={600}>Method 1: Manual Entry</Text>
              </Group>
              <Text size="sm" c="dimmed" mb="sm">
                Click "Add Tour" and fill in tour details. Tour Code becomes the Firebase ID.
              </Text>
              <Code block>
{`// Firebase path: /tours/{tourCode}
{
  "name": "Tour Name",
  "tourCode": "5209L 16",
  "days": 2,
  "startDate": "09/10/2025",
  "endDate": "10/10/2025",
  "isActive": true,
  "driverName": "TBA",
  "maxParticipants": 53,
  "currentParticipants": 0,
  "pickupPoints": [...],
  "itinerary": {...}
}`}
              </Code>
            </Paper>

            <Paper p="md" radius="md" bg="blue.0">
              <Group gap="xs" mb="sm">
                <ThemeIcon color="blue" variant="light" size="md">
                  <IconTemplate size={16} />
                </ThemeIcon>
                <Text fw={600}>Method 2: Templates</Text>
              </Group>
              <Text size="sm" c="dimmed" mb="sm">
                Use pre-configured templates with pickup points and itineraries already set up.
              </Text>
              <Text size="xs" c="dimmed">
                Available: Loch Lomond, Highlands, Edinburgh
              </Text>
            </Paper>

            <Paper p="md" radius="md" bg="orange.0">
              <Group gap="xs" mb="sm">
                <ThemeIcon color="orange" variant="light" size="md">
                  <IconUpload size={16} />
                </ThemeIcon>
                <Text fw={600}>Method 3: CSV Import</Text>
              </Group>
              <Text size="sm" c="dimmed" mb="sm">
                Import multiple tours from CSV. Columns: Tour Code, Name, Days, Start Date, End Date, etc.
              </Text>
              <Text size="xs" c="dimmed">
                Use Export to get a template CSV
              </Text>
            </Paper>
          </SimpleGrid>
        </Collapse>
      </Card>

      {/* Stats Cards */}
      <SimpleGrid cols={{
      base: 2,
      sm: 3,
      md: 5
    }} spacing="lg" mb="xl">
        <Paper p="md" radius="md" withBorder className="stat-card">
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Tours in {filterDateScope} view</Text>
              <Text size="xl" fw={700}>{totalTours}</Text>
            </div>
            <ThemeIcon color="brand" variant="light" size="xl" radius="md">
              <IconMap size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder className="stat-card">
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Assigned</Text>
              <Text size="xl" fw={700} c="green">{assignedTours}</Text>
            </div>
            <ThemeIcon color="green" variant="light" size="xl" radius="md">
              <IconCheck size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder className="stat-card">
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Unassigned</Text>
              <Text size="xl" fw={700} c="orange">{unassignedTours}</Text>
            </div>
            <ThemeIcon color="orange" variant="light" size="xl" radius="md">
              <IconX size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder className="stat-card">
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Active</Text>
              <Text size="xl" fw={700} c="blue">{activeTours}</Text>
            </div>
            <ThemeIcon color="blue" variant="light" size="xl" radius="md">
              <IconPlayerPlay size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper p="md" radius="md" withBorder className="stat-card">
          <Group justify="space-between">
            <div>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">Participants</Text>
              <Text size="xl" fw={700} c="grape">{totalParticipants}</Text>
            </div>
            <ThemeIcon color="grape" variant="light" size="xl" radius="md">
              <IconUsers size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Filters */}
      <Card shadow="sm" padding="md" radius="md" withBorder mb="lg">
        <Group justify="space-between" wrap="wrap" gap="md">
          <Group gap="md" wrap="wrap">
            <TextInput placeholder="Search tours, codes, drivers..." leftSection={<IconSearch size={16} />} value={searchTerm} onChange={e => handleSearchTermChange(e.target.value)} style={{
            width: 280
          }} />
            <Select placeholder="Filter by status" leftSection={<IconFilter size={16} />} data={[{
            value: 'all',
            label: 'All Tours'
          }, {
            value: 'assigned',
            label: 'Assigned'
          }, {
            value: 'unassigned',
            label: 'Unassigned (TBA)'
          }, {
            value: 'active',
            label: 'Active'
          }, {
            value: 'inactive',
            label: 'Inactive'
          }]} value={filterStatus} onChange={handleFilterStatusChange} style={{
            width: 180
          }} clearable={false} />
            <Select placeholder="Filter by date" leftSection={<IconCalendar size={16} />} data={[{
            value: 'current',
            label: 'Current & upcoming'
          }, {
            value: 'past',
            label: 'Past only'
          }, {
            value: 'all',
            label: 'All dates'
          }]} value={filterDateScope} onChange={handleDateScopeChange} style={{
            width: 210
          }} clearable={false} />
          </Group>
          <Group gap="md">
            <SegmentedControl value={viewMode} onChange={setViewMode} data={[{
            label: 'Grid',
            value: 'grid'
          }, {
            label: 'Table',
            value: 'table'
          }]} />
            <Text size="sm" c="dimmed">
              Showing {paginatedTours.length} of {filteredTours.length} tours
            </Text>
          </Group>
        </Group>
      </Card>

      {/* Tours Display */}
      {tourWindow.atLimit ? <Alert color="yellow" icon={<IconAlertCircle size={16} />} mb="md">
          This date view is capped at {tourWindow.limit} indexed tours. Refine the date/status filters before exporting or treating these totals as the complete archive.
        </Alert> : null}
      {driverDirectoryAtLimit ? <Alert color="yellow" icon={<IconAlertCircle size={16} />} mb="md">
          This screen keeps the first {500} drivers live for assignment coverage. Use the paged Drivers directory or an exact Driver ID search to manage drivers outside this live window.
        </Alert> : null}
      {packStatusSnapshot.atLimit ? <Alert color="yellow" icon={<IconAlertCircle size={16} />} mb="md">
          Driver Pack status view is capped at the most recent {packStatusSnapshot.limit} departures. Older tours may show Pack unavailable; use the management publication history before treating that as a current failure.
        </Alert> : null}
      {packOperationsSnapshot.atLimit ? <Alert color="yellow" icon={<IconAlertCircle size={16} />} mb="md">
          One or more visible departures reached the bounded operations-issue limit. The list is prioritised by unresolved severity and newest update; use the Driver Command Centre audit source before treating it as exhaustive.
        </Alert> : null}
      {filteredTours.length === 0 ? <Card shadow="sm" padding="xl" radius="md" withBorder>
          <Center>
            <Stack align="center" gap="md">
              <ThemeIcon color="gray" variant="light" size={60} radius="xl">
                <IconMap size={30} />
              </ThemeIcon>
              <Text c="dimmed" ta="center">
                {totalTours === 0 ? 'No tours yet. Click "Add Tour" to create your first tour.' : 'No tours found matching your criteria'}
              </Text>
              {totalTours === 0 && <Button leftSection={<IconPlus size={16} />} onClick={openCreateModal}>
                  Create First Tour
                </Button>}
            </Stack>
          </Center>
        </Card> : viewMode === 'grid' ? <SimpleGrid cols={{
      base: 1,
      sm: 2,
      md: 3,
      lg: 4
    }} spacing="lg">
          {paginatedTours.map(([id, tour]) => <TourCard key={id} tourId={id} tour={tour} drivers={drivers} packCoverage={packCoverageByTour[id]} packOperations={packOperationsByTour[id]} onIssueStatus={handleIssueStatus} updatingIssueId={updatingIssueId} onEdit={handleEdit} onDelete={handleDelete} onDuplicate={handleDuplicate} onViewDetails={handleViewDetails} onAddPassenger={handleAddPassenger} />)}
        </SimpleGrid> : <Card shadow="sm" padding="md" radius="md" withBorder>
          <ScrollArea>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Tour</Table.Th>
                  <Table.Th>Code</Table.Th>
                  <Table.Th>Days</Table.Th>
                  <Table.Th>Dates</Table.Th>
                  <Table.Th>Driver</Table.Th>
                  <Table.Th>Capacity</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Driver pack</Table.Th>
                  <Table.Th>Live operations</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {paginatedTours.map(([id, tour]) => {
              const isAssigned = tour.driverName && tour.driverName !== 'TBA';
              return <Table.Tr key={id} className="table-row-clickable" onClick={() => handleViewDetails(id)}>
                      <Table.Td>
                        <Group gap="xs">
                          <ThemeIcon color="brand" variant="light" size="sm">
                            <IconMap size={12} />
                          </ThemeIcon>
                          <Text fw={500} size="sm" truncate="end" style={{
                      maxWidth: 200
                    }}>
                            {tour.name || id}
                          </Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Code>{tour.tourCode || id}</Code>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" size="sm">
                          {tour.days || 1} day{(tour.days || 1) > 1 ? 's' : ''}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">{formatDateForDisplay(tour.startDate)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs">
                          <Avatar size="xs" radius="xl" color={isAssigned ? 'brand' : 'gray'}>
                            {tour.driverName?.charAt(0) || '?'}
                          </Avatar>
                          <Text size="sm">{tour.driverName || 'TBA'}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{tour.currentParticipants || 0}/{tour.maxParticipants || 53}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={tour.isActive ? 'green' : 'gray'} size="sm">
                          {tour.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </Table.Td>
                      <Table.Td><TourPackStatus coverage={packCoverageByTour[id]} /></Table.Td>
                      <Table.Td><DriverPackOperations operations={packOperationsByTour[id]} onIssueStatus={handleIssueStatus} updatingIssueId={updatingIssueId} /></Table.Td>
                      <Table.Td onClick={e => e.stopPropagation()}>
                        <Group gap="xs">
                          <Tooltip label="View Details">
                            <ActionIcon variant="light" color="brand" onClick={() => handleViewDetails(id)}>
                              <IconEye size={14} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Edit">
                            <ActionIcon variant="light" color="blue" onClick={() => handleEdit(id)}>
                              <IconEdit size={14} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Add Passenger">
                            <ActionIcon variant="light" color="green" onClick={() => handleAddPassenger(id)}>
                              <IconUserPlus size={14} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Delete">
                            <ActionIcon variant="light" color="red" onClick={() => handleDelete(id)}>
                              <IconTrash size={14} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>;
            })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Card>}

      {/* Pagination */}
      {totalPages > 1 && <Center mt="xl">
          <Pagination total={totalPages} value={currentPage} onChange={setCurrentPage} size="md" radius="md" />
        </Center>}

      {/* Modals */}
      <CreateTourModal opened={createModalOpened} onClose={closeCreateModal} onSuccess={handleTourCreated} userEmail="admin" />

      {editModalOpened && <EditTourModal key={selectedTourId || 'new-selection'} opened={editModalOpened} onClose={closeEditModal} tourId={selectedTourId} tour={selectedTour} onSuccess={() => {}} />}

      <DeleteTourModal opened={deleteModalOpened} onClose={closeDeleteModal} tourId={selectedTourId} tourName={selectedTour?.name} onConfirm={() => setSelectedTourId(null)} />

      <TourDetailsModal opened={detailsModalOpened} onClose={closeDetailsModal} tourId={selectedTourId} tour={selectedTour} />

      <AddPassengerModal opened={addPassengerModalOpened} onClose={closeAddPassengerModal} tours={tours} initialTourId={selectedTourId || ''} onSuccess={handlePassengerCreated} />

      <ImportExportModal opened={importExportModalOpened} onClose={closeImportExportModal} tours={tours} drivers={drivers} dateScope={filterDateScope} onImportSuccess={() => {}} />
    </Box>;
}
