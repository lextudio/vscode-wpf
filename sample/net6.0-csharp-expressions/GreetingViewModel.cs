using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace sample;

/// <summary>
/// Demo view model for the WXSG C# expressions sample.
///
/// Today (Phase 1) these properties are consumed via standard {Binding} in XAML.
///
/// WXSG Phase 5 goal — inline C# expressions in XAML attributes, e.g.:
///   Text="{cs: Greeting.ToUpper()}"
///   Visibility="{cs: Items.Count > 0 ? Visibility.Visible : Visibility.Collapsed}"
///   Content="{cs: $"Hello, {FirstName} {LastName}!"}"
///
/// At that stage WXSG compiles expressions into the generated InitializeComponent
/// directly — no IValueConverter, no reflection, no boxing overhead.
/// </summary>
public sealed class GreetingViewModel : INotifyPropertyChanged
{
    private string _firstName = "Ada";
    private string _lastName = "Lovelace";
    private string _newItem = string.Empty;

    public string FirstName
    {
        get => _firstName;
        set { _firstName = value; OnPropertyChanged(); OnPropertyChanged(nameof(FullName)); }
    }

    public string LastName
    {
        get => _lastName;
        set { _lastName = value; OnPropertyChanged(); OnPropertyChanged(nameof(FullName)); }
    }

    // Phase 5 goal: this expression lives in XAML as {cs: FirstName + " " + LastName}
    public string FullName => $"{FirstName} {LastName}";

    // Phase 5 goal: {cs: $"Hello, {FullName}!"}
    public string Greeting => $"Hello, {FullName}!";

    public ObservableCollection<string> Items { get; } = new()
    {
        "First item",
        "Second item",
        "Third item",
    };

    public string NewItem
    {
        get => _newItem;
        set { _newItem = value; OnPropertyChanged(); }
    }

    public void AddItem()
    {
        if (!string.IsNullOrWhiteSpace(NewItem))
        {
            Items.Add(NewItem.Trim());
            NewItem = string.Empty;
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
