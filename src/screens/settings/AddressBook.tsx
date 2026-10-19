'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/context/ToastContext';
import useAddressBook from '@/hooks/useAddressBook';

export default function AddressBookPage() {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const {
    addressBook,
    status,
    recovery,
    dismissRecovery,
    addAddress,
    updateAddress,
    deleteAddress,
    searchAddresses,
  } = useAddressBook();

  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  // Controlled state for the inline-edit form (#862 fix: was uncontrolled defaultValue)
  const [editAddress, setEditAddress] = useState('');
  const [editNickname, setEditNickname] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [newNickname, setNewNickname] = useState('');

  const filteredAddresses = searchAddresses(searchQuery);

  // ── Add ──────────────────────────────────────────────────────────────────────

  const handleAddAddress = async () => {
    const result = await addAddress(newAddress, newNickname);
    if (!result.ok) {
      const errorKey: Record<typeof result.error, string> = {
        MISSING_FIELDS: 'addressBook.errors.missingFields',
        INVALID_ADDRESS: 'addressBook.errors.invalidAddress',
        DUPLICATE_ADDRESS: 'addressBook.errors.duplicateAddress',
        PERSIST_FAILED: 'addressBook.errors.saveFailed',
        CRYPTO_FAILED: 'addressBook.errors.saveFailed',
      };
      addToast({ type: 'error', title: t(errorKey[result.error]) });
      return;
    }
    setNewAddress('');
    setNewNickname('');
    addToast({ type: 'success', title: t('addressBook.success.added') });
  };

  // ── Edit ─────────────────────────────────────────────────────────────────────

  const handleStartEdit = (id: string) => {
    const entry = addressBook.find((e) => e.id === id);
    if (!entry) return;
    setEditAddress(entry.address);
    setEditNickname(entry.nickname);
    setEditingId(id);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditAddress('');
    setEditNickname('');
  };

  const handleUpdateAddress = async (id: string) => {
    const result = await updateAddress(id, { address: editAddress, nickname: editNickname });
    if (!result.ok) {
      const errorKey: Record<typeof result.error, string> = {
        MISSING_FIELDS: 'addressBook.errors.missingFields',
        INVALID_ADDRESS: 'addressBook.errors.invalidAddress',
        DUPLICATE_ADDRESS: 'addressBook.errors.duplicateAddress',
        PERSIST_FAILED: 'addressBook.errors.saveFailed',
        CRYPTO_FAILED: 'addressBook.errors.saveFailed',
      };
      addToast({ type: 'error', title: t(errorKey[result.error]) });
      // Keep the edit form open so the user can correct the input or retry.
      return;
    }
    handleCancelEdit();
    addToast({ type: 'success', title: t('addressBook.success.updated') });
  };

  // ── Delete ───────────────────────────────────────────────────────────────────

  const handleDeleteAddress = async (id: string) => {
    await deleteAddress(id);
    addToast({ type: 'success', title: t('addressBook.success.deleted') });
  };

  const formatAddress = (addr: string): string => {
    if (!addr) return '';
    if (addr.length <= 10) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <div className="space-y-6">
      {recovery && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-xl border border-error/30 bg-error-container/40 p-4 text-sm"
        >
          <div>
            <p className="font-medium">{t('addressBook.recovery.title')}</p>
            <p className="text-on-surface-variant">{t(`addressBook.recovery.${recovery}`)}</p>
          </div>
          <button
            type="button"
            onClick={dismissRecovery}
            className="shrink-0 rounded-lg px-3 py-1 font-medium hover:bg-surface-container-high"
          >
            {t('addressBook.recovery.dismiss')}
          </button>
        </div>
      )}
      {status === 'unavailable' && (
        <div
          role="alert"
          className="rounded-xl border border-error/30 bg-error-container/40 p-4 text-sm"
        >
          {t('addressBook.errors.storageUnavailable')}
        </div>
      )}
      <div className="border border-surface-dim rounded-xl overflow-hidden">
        <div className="flex items-center justify-between p-4 bg-surface-container-low">
          <h3 className="text-lg font-medium">{t('addressBook.title')}</h3>
          <p className="text-sm text-on-surface-variant">{t('addressBook.subtitle')}</p>
        </div>
        <div className="p-4 space-y-3">
          <div className="space-y-2">
            <label className="flex items-center justify-between text-sm font-medium text-on-surface-variant">
              {t('addressBook.newAddress')}
              <span className="text-xs text-on-surface-variant/50">
                ({t('addressBook.maxEntries', { count: 50 })} {t('addressBook.entries')})
              </span>
            </label>
            <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
              <input
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                placeholder={t('addressBook.stellarAddressPlaceholder')}
                className="w-full rounded-2xl bg-surface-container-low px-4 py-3.5 text-sm border border-outline-variant/15 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
                inputMode="decimal"
              />
              <input
                value={newNickname}
                onChange={(e) => setNewNickname(e.target.value)}
                placeholder={t('addressBook.nicknamePlaceholder')}
                className="w-full rounded-2xl bg-surface-container-low px-4 py-3.5 text-sm border border-outline-variant/15 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
              />
            </div>
            <button
              onClick={handleAddAddress}
              className="w-full rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-surface-container-lowest hover:bg-primary/90 transition-colors"
            >
              {t('addressBook.addAddress')}
            </button>
          </div>
        </div>
      </div>

      <div className="border border-surface-dim rounded-xl overflow-hidden">
        <div className="flex items-center justify-between p-4 bg-surface-container-low">
          <h3 className="text-lg font-medium">{t('addressBook.yourAddresses')}</h3>
          <div className="flex items-center gap-2">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('addressBook.searchPlaceholder')}
              className="rounded-xl bg-surface-container-low px-4 py-3 text-sm border border-outline-variant/15 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none w-[200px]"
            />
            {filteredAddresses.length !== addressBook.length && (
              <span className="text-xs text-on-surface-variant">
                {filteredAddresses.length} {t('addressBook.shownOf', { total: addressBook.length })}
              </span>
            )}
          </div>
        </div>
        {filteredAddresses.length === 0 ? (
          <div className="p-8 text-center text-on-surface-variant">
            <p>{t('addressBook.noAddresses')}</p>
            <p className="mt-2 text-xs">{t('addressBook.noAddressesHint')}</p>
          </div>
        ) : (
          <div className="divide-y divide-surface-dim">
            {filteredAddresses.map((entry) => (
              <div
                key={entry.id}
                className={`p-4 flex justify-between items-start ${
                  editingId === entry.id ? 'bg-primary/5' : ''
                }`}
              >
                {editingId === entry.id ? (
                  <div className="flex flex-col gap-2 w-[300px]">
                    <input
                      value={editAddress}
                      onChange={(e) => setEditAddress(e.target.value)}
                      aria-label={t('addressBook.editAddressLabel')}
                      className="w-full rounded-xl bg-surface-container-low px-4 py-3 text-sm border border-outline-variant/15 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
                    />
                    <input
                      value={editNickname}
                      onChange={(e) => setEditNickname(e.target.value)}
                      aria-label={t('addressBook.editNicknameLabel')}
                      className="w-full rounded-xl bg-surface-container-low px-4 py-3 text-sm border border-outline-variant/15 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleUpdateAddress(entry.id)}
                        className="flex-1 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-surface-container-lowest hover:bg-primary/90 transition-colors"
                      >
                        {t('addressBook.save')}
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="flex-1 rounded-xl bg-surface-container-low px-4 py-3 text-sm font-bold text-on-surface-variant border border-outline-variant/15 hover:bg-surface-variant/50 transition-colors"
                      >
                        {t('addressBook.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start gap-4">
                      <div className="flex-shrink-0">
                        <div className="bg-primary-container text-on-primary-container rounded-xl p-3">
                          <span className="material-symbols-outlined">account_circle</span>
                        </div>
                      </div>
                      <div className="flex-1 space-y-1">
                        <p className="font-medium">{entry.nickname}</p>
                        <p className="text-xs text-on-surface-variant break-all">
                          {formatAddress(entry.address)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-end gap-2">
                      <button
                        onClick={() => handleStartEdit(entry.id)}
                        className="p-1 rounded-full hover:bg-surface-variant/50 transition-colors"
                        title={t('addressBook.edit')}
                      >
                        <span className="material-symbols-outlined">edit</span>
                      </button>
                      <button
                        onClick={() => handleDeleteAddress(entry.id)}
                        className="p-1 rounded-full text-error-container hover:bg-error-container/20 transition-colors"
                        title={t('addressBook.delete')}
                      >
                        <span className="material-symbols-outlined">delete</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
