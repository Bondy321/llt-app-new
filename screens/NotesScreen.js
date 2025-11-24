import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialCommunityIcons } from '@expo/vector-icons';

const COLORS = {
  primaryBlue: '#007DC3',
  lightBlue: '#E8F2FF',
  white: '#FFFFFF',
  darkText: '#1A202C',
  mutedText: '#6B7280',
  coralAccent: '#FF7757',
  successGreen: '#10B981',
};

const STORAGE_PREFIX = '@LLT:notes:';

export default function NotesScreen({ onBack, tourId }) {
  const [notes, setNotes] = useState([]);
  const [draft, setDraft] = useState('');
  const [noteTag, setNoteTag] = useState('General');
  const [tagFilter, setTagFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [editingId, setEditingId] = useState(null);
  const storageKey = `${STORAGE_PREFIX}${tourId || 'general'}`;

  const TAG_OPTIONS = ['General', 'Pickup', 'Food', 'Packing', 'People'];

  useEffect(() => {
    loadNotes();
  }, [storageKey]);

  const loadNotes = async () => {
    try {
      const stored = await AsyncStorage.getItem(storageKey);
      if (stored) {
        setNotes(JSON.parse(stored));
      }
    } catch (error) {
      console.warn('Failed to load notes', error);
    }
  };

  const persistNotes = async (nextNotes) => {
    setNotes(nextNotes);
    try {
      await AsyncStorage.setItem(storageKey, JSON.stringify(nextNotes));
    } catch (error) {
      console.warn('Failed to save notes', error);
    }
  };

  const addNote = () => {
    if (!draft.trim()) return;
    if (editingId) {
      const updated = notes.map((note) =>
        note.id === editingId
          ? {
              ...note,
              text: draft.trim(),
              tag: noteTag,
              updatedAt: new Date().toISOString(),
            }
          : note
      );
      persistNotes(updated);
      setEditingId(null);
    } else {
      const newNote = {
        id: Date.now().toString(),
        text: draft.trim(),
        tag: noteTag,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        done: false,
      };
      persistNotes([newNote, ...notes]);
    }
    setDraft('');
  };

  const toggleDone = (id) => {
    const updated = notes.map((note) =>
      note.id === id ? { ...note, done: !note.done } : note
    );
    persistNotes(updated);
  };

  const deleteNote = (id) => {
    const filtered = notes.filter((note) => note.id !== id);
    persistNotes(filtered);
  };

  const startEditing = (note) => {
    setEditingId(note.id);
    setDraft(note.text);
    setNoteTag(note.tag || 'General');
  };

  const cancelEditing = () => {
    setEditingId(null);
    setDraft('');
    setNoteTag('General');
  };

  const filteredNotes = notes.filter((note) => {
    const matchesStatus =
      statusFilter === 'All' || (statusFilter === 'Done' ? note.done : !note.done);
    const matchesTag = tagFilter === 'All' || note.tag === tagFilter;
    return matchesStatus && matchesTag;
  });

  const sortedNotes = [...filteredNotes].sort((a, b) => {
    if (a.done !== b.done) {
      return a.done ? 1 : -1;
    }
    return (
      new Date(b.updatedAt || b.createdAt).getTime() -
      new Date(a.updatedAt || a.createdAt).getTime()
    );
  });

  const renderItem = ({ item }) => (
    <View style={styles.noteCard}>
      <TouchableOpacity
        style={[styles.statusBadge, item.done && styles.statusBadgeDone]}
        onPress={() => toggleDone(item.id)}
        accessibilityLabel={item.done ? 'Mark note as to-do' : 'Mark note as done'}
      >
        <MaterialCommunityIcons
          name={item.done ? 'check-circle' : 'checkbox-blank-circle-outline'}
          size={22}
          color={item.done ? COLORS.coralAccent : COLORS.primaryBlue}
        />
      </TouchableOpacity>
      <View style={styles.noteContent}>
        <View style={styles.noteHeader}>
          <Text style={[styles.tagPill, item.done && styles.tagPillDone]}>{item.tag || 'General'}</Text>
          {item.updatedAt && item.updatedAt !== item.createdAt && (
            <Text style={styles.updatedBadge}>Edited</Text>
          )}
        </View>
        <Text style={[styles.noteText, item.done && styles.noteTextDone]}>{item.text}</Text>
        <Text style={styles.noteMeta}>
          Saved {new Date(item.createdAt).toLocaleString()}
          {item.updatedAt && item.updatedAt !== item.createdAt &&
            ` • Updated ${new Date(item.updatedAt).toLocaleString()}`}
        </Text>
      </View>
      <View style={styles.noteActions}>
        <TouchableOpacity
          onPress={() => startEditing(item)}
          style={styles.iconButton}
          accessibilityLabel="Edit note"
        >
          <MaterialCommunityIcons name="pencil-outline" size={20} color={COLORS.primaryBlue} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => deleteNote(item.id)}
          style={[styles.iconButton, styles.deleteButton]}
          accessibilityLabel="Delete note"
        >
          <MaterialCommunityIcons name="trash-can-outline" size={20} color={COLORS.mutedText} />
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={80}
      >
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={onBack} accessibilityLabel="Back to home">
            <MaterialCommunityIcons name="arrow-left" size={22} color={COLORS.primaryBlue} />
          </TouchableOpacity>
          <View style={styles.headerTextContainer}>
            <Text style={styles.title}>My Notes</Text>
            <Text style={styles.subtitle}>Capture and organize quick reminders for this tour</Text>
          </View>
        </View>

        <View style={styles.inputCard}>
          <MaterialCommunityIcons name="notebook-edit-outline" size={22} color={COLORS.primaryBlue} />
          <TextInput
            style={styles.input}
            placeholder="Add a personal reminder"
            placeholderTextColor={COLORS.mutedText}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={addNote}
            returnKeyType="done"
          />
          <TouchableOpacity
            style={[styles.addButton, !draft.trim() && styles.addButtonDisabled]}
            onPress={addNote}
            disabled={!draft.trim()}
            accessibilityLabel={editingId ? 'Update note' : 'Add note'}
          >
            <MaterialCommunityIcons
              name={editingId ? 'content-save-edit-outline' : 'plus'}
              size={24}
              color={COLORS.white}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.tagRow}>
          {TAG_OPTIONS.map((tag) => (
            <TouchableOpacity
              key={tag}
              style={[styles.tagOption, noteTag === tag && styles.tagOptionActive]}
              onPress={() => setNoteTag(tag)}
              accessibilityLabel={`Tag note as ${tag}`}
            >
              <Text
                style={[styles.tagOptionText, noteTag === tag && styles.tagOptionTextActive]}
              >
                {tag}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.filterRow}>
          {['All', 'To-Do', 'Done'].map((status) => (
            <TouchableOpacity
              key={status}
              style={[styles.filterChip, statusFilter === status && styles.filterChipActive]}
              onPress={() => setStatusFilter(status)}
              accessibilityLabel={`Show ${status} notes`}
            >
              <Text
                style={[styles.filterChipText, statusFilter === status && styles.filterChipTextActive]}
              >
                {status}
              </Text>
            </TouchableOpacity>
          ))}
          <View style={styles.filterDivider} />
          {['All', ...TAG_OPTIONS].map((tag) => (
            <TouchableOpacity
              key={`filter-${tag}`}
              style={[styles.filterChip, tagFilter === tag && styles.filterChipActive]}
              onPress={() => setTagFilter(tag)}
              accessibilityLabel={`Filter notes by ${tag === 'All' ? 'all tags' : tag}`}
            >
              <Text
                style={[styles.filterChipText, tagFilter === tag && styles.filterChipTextActive]}
              >
                {tag}
              </Text>
            </TouchableOpacity>
          ))}
          {editingId && (
            <TouchableOpacity
              style={styles.cancelEditButton}
              onPress={cancelEditing}
              accessibilityLabel="Cancel editing"
            >
              <MaterialCommunityIcons name="close-circle-outline" size={20} color={COLORS.white} />
              <Text style={styles.cancelEditText}>Cancel edit</Text>
            </TouchableOpacity>
          )}
        </View>

        {sortedNotes.length === 0 ? (
          <View style={styles.emptyState}>
            <MaterialCommunityIcons name="lightbulb-on-outline" size={30} color={COLORS.primaryBlue} />
            <Text style={styles.emptyTitle}>No notes yet</Text>
            <Text style={styles.emptySubtitle}>
              Save seat mates' names, pickup tweaks, or ideas to remember later. Organize them by tag and
              mark items done as you go.
            </Text>
          </View>
        ) : (
          <FlatList
            data={sortedNotes}
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
          />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.lightBlue,
  },
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 4,
  },
  headerTextContainer: {
    flex: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: COLORS.darkText,
  },
  subtitle: {
    fontSize: 14,
    color: COLORS.mutedText,
    marginTop: 4,
  },
  inputCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 5,
    marginBottom: 15,
  },
  input: {
    flex: 1,
    marginLeft: 10,
    fontSize: 16,
    color: COLORS.darkText,
  },
  addButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.primaryBlue,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 10,
  },
  addButtonDisabled: {
    backgroundColor: '#B6C8DC',
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  tagOption: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: '#E5E7EB',
    marginRight: 8,
    marginBottom: 8,
  },
  tagOptionActive: {
    backgroundColor: COLORS.primaryBlue,
  },
  tagOptionText: {
    color: COLORS.darkText,
    fontSize: 13,
    fontWeight: '600',
  },
  tagOptionTextActive: {
    color: COLORS.white,
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  filterDivider: {
    height: 18,
    width: 1,
    backgroundColor: '#D1D5DB',
    marginRight: 8,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    marginRight: 8,
    marginBottom: 8,
  },
  filterChipActive: {
    backgroundColor: COLORS.lightBlue,
    borderColor: COLORS.primaryBlue,
  },
  filterChipText: {
    fontSize: 13,
    color: COLORS.darkText,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: COLORS.primaryBlue,
  },
  cancelEditButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: COLORS.coralAccent,
  },
  cancelEditText: {
    color: COLORS.white,
    marginLeft: 6,
    fontWeight: '700',
  },
  emptyState: {
    backgroundColor: COLORS.white,
    padding: 20,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 40,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 4,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.darkText,
    marginTop: 10,
  },
  emptySubtitle: {
    fontSize: 14,
    color: COLORS.mutedText,
    textAlign: 'center',
    marginTop: 6,
  },
  listContent: {
    paddingBottom: 40,
  },
  noteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    padding: 14,
    borderRadius: 12,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 4,
  },
  statusBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.lightBlue,
    marginRight: 12,
  },
  statusBadgeDone: {
    backgroundColor: '#FFE3DB',
  },
  noteContent: {
    flex: 1,
  },
  noteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  tagPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: COLORS.lightBlue,
    color: COLORS.primaryBlue,
    fontWeight: '700',
    fontSize: 12,
    marginRight: 8,
  },
  tagPillDone: {
    backgroundColor: '#FFE3DB',
    color: COLORS.coralAccent,
  },
  updatedBadge: {
    fontSize: 11,
    color: COLORS.successGreen,
    fontWeight: '700',
    marginLeft: 4,
  },
  noteText: {
    fontSize: 16,
    color: COLORS.darkText,
    marginBottom: 4,
  },
  noteTextDone: {
    textDecorationLine: 'line-through',
    color: COLORS.mutedText,
  },
  noteMeta: {
    fontSize: 12,
    color: COLORS.mutedText,
  },
  noteActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
  },
  iconButton: {
    padding: 6,
    borderRadius: 10,
    backgroundColor: COLORS.lightBlue,
    marginLeft: 6,
  },
  deleteButton: {
    backgroundColor: '#FEE2E2',
  },
});
