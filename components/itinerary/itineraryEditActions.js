import { Alert, LayoutAnimation, Share } from 'react-native';
import logger from '../../services/loggerService';
import { saveItineraryDraft } from '../../services/itineraryEditRepository';
import { ITINERARY_DATA_SOURCE } from '../../utils/itinerarySyncPresentation';
import {
  createItineraryContentSignature, validateItineraryDraft,
} from '../../services/itineraryService';

export default function createItineraryEditActions(context) {
  const { cacheItinerary, editBaseSignatureRef, editConflict, editedItinerary, itinerary, parsedTourStartDate, setDataSource, setEditConflict, setEditedItinerary, setIsEditing, setItinerary, setOperationMessage, setSaving, startDate, tourId, tourName } = context;

  const handleEditDayContent = (dayIndex, value) => {
    const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
    newItinerary.days[dayIndex].content = value;
    setEditedItinerary(newItinerary);
  };

  const handleAddDay = () => {
    const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
    const newDayNumber = (newItinerary.days?.length || 0) + 1;

    if (!newItinerary.days) {
      newItinerary.days = [];
    }

    newItinerary.days.push({
      day: newDayNumber,
      content: ''
    });

    setEditedItinerary(newItinerary);
    logger.info('ItineraryScreen', 'Edit itinerary day added', {
      tourId,
      newDayNumber,
      dayCount: newItinerary.days.length,
    });
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  };

  const handleRemoveDay = (dayIndex) => {
    Alert.alert(
      "Delete Day",
      "Are you sure you want to delete this entire day?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
            newItinerary.days.splice(dayIndex, 1);
            // Re-number remaining days
            newItinerary.days.forEach((day, idx) => {
              day.day = idx + 1;
            });
            setEditedItinerary(newItinerary);
            logger.info('ItineraryScreen', 'Edit itinerary day removed', {
              tourId,
              removedDayIndex: dayIndex,
              dayCount: newItinerary.days.length,
            });
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          }
        }
      ]
    );
  };

  const handleDuplicateDay = (dayIndex) => {
    Alert.alert(
      "Duplicate Day",
      "Create a copy of this day?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Duplicate",
          onPress: () => {
            const newItinerary = JSON.parse(JSON.stringify(editedItinerary));
            const dayToCopy = JSON.parse(JSON.stringify(newItinerary.days[dayIndex]));
            dayToCopy.day = newItinerary.days.length + 1;
            newItinerary.days.push(dayToCopy);
            setEditedItinerary(newItinerary);
            logger.info('ItineraryScreen', 'Edit itinerary day duplicated', {
              tourId,
              sourceDayIndex: dayIndex,
              newDayNumber: dayToCopy.day,
              dayCount: newItinerary.days.length,
            });
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          }
        }
      ]
    );
  };

  const beginEditing = (draft = itinerary) => {
    editBaseSignatureRef.current = createItineraryContentSignature(itinerary || null);
    setEditedItinerary(JSON.parse(JSON.stringify(draft || {
      title: tourName || 'Tour',
      days: [{ day: 1, content: '' }],
    })));
    setEditConflict(null);
    setOperationMessage('');
    setIsEditing(true);
    logger.info('ItineraryScreen', 'Itinerary edit session started', {
      tourId,
      revision: itinerary?.revision || 0,
      dayCount: Array.isArray(draft?.days) ? draft.days.length : 1,
    });
  };

  // --- SAVE WITH RETRY ---
  const handleSaveChanges = async (retryAttempt = 0) => {
    if (editConflict) return;
    const validation = validateItineraryDraft(editedItinerary);
    if (!validation.valid) {
      Alert.alert('Check the itinerary', validation.error);
      return;
    }
    setSaving(true);
    logger.info('ItineraryScreen', 'Itinerary save started', {
      tourId,
      retryAttempt,
      dayCount: Array.isArray(editedItinerary?.days) ? editedItinerary.days.length : null,
    });
    try {
      const result = await saveItineraryDraft({
        tourId,
        draft: editedItinerary,
        expectedContentSignature: editBaseSignatureRef.current,
      });

      if (result.validationError) {
        Alert.alert('Check the itinerary', result.validationError);
        return;
      }

      if (result.conflict) {
        const serverItinerary = result.serverItinerary || null;
        setItinerary(serverItinerary);
        setDataSource(ITINERARY_DATA_SOURCE.LIVE);
        await cacheItinerary(serverItinerary);
        setEditConflict({
          serverItinerary,
          serverRevision: serverItinerary?.revision || 0,
        });
        logger.warn('ItineraryScreen', 'Itinerary save prevented a stale overwrite', {
          tourId,
          serverRevision: serverItinerary?.revision || 0,
          draftDayCount: Array.isArray(editedItinerary?.days) ? editedItinerary.days.length : null,
        });
        return;
      }

      if (!result.success || !result.itinerary) {
        throw new Error('Itinerary save did not complete');
      }

      setItinerary(result.itinerary);
      setEditedItinerary(JSON.parse(JSON.stringify(result.itinerary)));
      editBaseSignatureRef.current = createItineraryContentSignature(result.itinerary);
      await cacheItinerary(result.itinerary);
      setIsEditing(false);
      setEditConflict(null);
      setDataSource(ITINERARY_DATA_SOURCE.LIVE);
      setOperationMessage('Itinerary published. Everyone on the tour will see this latest version.');
      logger.info('ItineraryScreen', 'Itinerary save completed', {
        tourId,
        retryAttempt,
        dayCount: Array.isArray(result.itinerary?.days) ? result.itinerary.days.length : null,
        revision: result.itinerary?.revision || null,
      });
    } catch (error) {
      logger.error('ItineraryScreen', 'Itinerary save failed', {
        tourId,
        retryAttempt,
        error: error?.message || String(error),
      });

      if (retryAttempt < 2) {
        Alert.alert(
          "Connection Issue",
          "Failed to save. Retry?",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Retry",
              onPress: () => handleSaveChanges(retryAttempt + 1)
            }
          ]
        );
      } else {
        Alert.alert("Error", "Could not save changes after multiple attempts. Please check your connection.");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleUseLatestItinerary = () => {
    const serverItinerary = editConflict?.serverItinerary || null;
    setEditedItinerary(JSON.parse(JSON.stringify(serverItinerary || {
      title: tourName || 'Tour',
      days: [{ day: 1, content: '' }],
    })));
    editBaseSignatureRef.current = createItineraryContentSignature(serverItinerary);
    setEditConflict(null);
    logger.info('ItineraryScreen', 'Driver loaded protected server itinerary after conflict', {
      tourId,
      serverRevision: serverItinerary?.revision || 0,
    });
  };

  const handleKeepDraftAfterConflict = () => {
    Alert.alert(
      'Replace the newer version?',
      "Your draft will become the next published version when you tap Save. Review every day first so you do not remove another operator's changes.",
      [
        { text: 'Keep comparing', style: 'cancel' },
        {
          text: 'Use my draft',
          style: 'destructive',
          onPress: () => {
            editBaseSignatureRef.current = createItineraryContentSignature(editConflict?.serverItinerary || null);
            setEditConflict(null);
            logger.warn('ItineraryScreen', 'Driver explicitly chose draft after itinerary conflict', {
              tourId,
              serverRevision: editConflict?.serverRevision || 0,
            });
          },
        },
      ],
    );
  };

  const handleCancelEdit = () => {
    logger.info('ItineraryScreen', 'Itinerary edit cancel confirmation opened', { tourId });
    Alert.alert(
      "Discard Changes?",
      "All unsaved changes will be lost.",
      [
        { text: "Keep Editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            setEditedItinerary(JSON.parse(JSON.stringify(itinerary)));
            setIsEditing(false);
            setEditConflict(null);
            logger.info('ItineraryScreen', 'Itinerary edit discarded', { tourId });
          }
        }
      ]
    );
  };

  // --- EXPORT TO CALENDAR ---
  const handleExportToCalendar = async () => {
    if (!itinerary?.days || !startDate) {
      logger.warn('ItineraryScreen', 'Calendar export blocked by missing data', {
        tourId,
        hasDays: Boolean(itinerary?.days),
        hasStartDate: Boolean(startDate),
      });
      Alert.alert("Error", "Cannot export: missing itinerary data");
      return;
    }

    try {
      const parsedStart = parsedTourStartDate;
      if (!parsedStart) {
        logger.warn('ItineraryScreen', 'Calendar export blocked by unsupported start date', {
          tourId,
          startDate,
        });
        Alert.alert("Unsupported start date", "Calendar export supports dd/MM/yyyy or yyyy-MM-dd dates.");
        return;
      }
      logger.info('ItineraryScreen', 'Calendar export started', {
        tourId,
        dayCount: itinerary.days.length,
        startDate,
      });
      let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//LLT Tours//Itinerary//EN\n";

      itinerary.days.forEach((day, dayIndex) => {
        const dayDate = new Date(parsedStart);
        dayDate.setDate(parsedStart.getDate() + dayIndex);
        const dateStr = dayDate.toISOString().split('T')[0].replace(/-/g, '');

        const content = day.content || '';
        if (content) {
          icsContent += `BEGIN:VEVENT\n`;
          icsContent += `DTSTART;VALUE=DATE:${dateStr}\n`;
          icsContent += `DTEND;VALUE=DATE:${dateStr}\n`;
          icsContent += `SUMMARY:Day ${day.day} - ${itinerary.title || tourName || 'Tour'}\n`;
          icsContent += `DESCRIPTION:${content.replace(/\n/g, '\\n')}\n`;
          icsContent += `END:VEVENT\n`;
        }
      });

      icsContent += "END:VCALENDAR";

      await Share.share({
        message: icsContent,
        title: `${tourName || 'Tour'} Itinerary`
      });
      logger.info('ItineraryScreen', 'Calendar export share sheet opened', {
        tourId,
        characterCount: icsContent.length,
      });
    } catch (error) {
      logger.error('ItineraryScreen', 'Calendar export failed', {
        tourId,
        error: error?.message || String(error),
      });
      Alert.alert("Export Failed", "Could not export to calendar");
    }
  };

  return { beginEditing, handleAddDay, handleCancelEdit, handleDuplicateDay, handleEditDayContent, handleExportToCalendar, handleKeepDraftAfterConflict, handleRemoveDay, handleSaveChanges, handleUseLatestItinerary };
}
